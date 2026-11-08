// Rule-engine unit tests: CN classification, CIDR boundaries, rule precedence,
// invalid-rule diagnostics. Offline: uses only the embedded data tables.
import test from "node:test";
import assert from "node:assert/strict";
import {
	RuleEngine,
	cidr6Contains,
	inCnCidr4,
	inCnCidr6,
	ipv4ToInt,
	ipv6ToGroups,
	releaseRuleData
} from "../lib/core/rules.js";

test.after(() => releaseRuleData());

test("ipv4ToInt accepts only strict dotted quads", () => {
	assert.equal(ipv4ToInt("0.0.0.0"), 0);
	assert.equal(ipv4ToInt("255.255.255.255"), 0xffffffff);
	assert.equal(ipv4ToInt("1.2.3.4"), 0x01020304);
	for (const bad of ["1.2.3.", "1.2.3", "01.2.3.4", "1.2.3.256", "1.2.3.4.5", " 1.2.3.4", "1.2.3.4\n", "", "::1"]) {
		assert.equal(ipv4ToInt(bad), null, bad);
	}
});

test("ipv6ToGroups handles compression, brackets and embedded IPv4", () => {
	assert.deepEqual(ipv6ToGroups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(ipv6ToGroups("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(ipv6ToGroups("2001:db8::1"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(ipv6ToGroups("[2001:db8::1]"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(ipv6ToGroups("2001:0db8:0000:0000:0000:0000:0000:0001"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual(ipv6ToGroups("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
	assert.deepEqual(ipv6ToGroups("1.2.3.4"), null, "a bare IPv4 is not IPv6");
	for (const bad of [":::", "1::2::3", "12345::", "2001:db8::1::2", "fe80::1%eth0", "::ffff:999.1.1.1", "gggg::1", ""]) {
		assert.equal(ipv6ToGroups(bad), null, bad);
	}
});

test("cidr6Contains respects partial-group prefixes", () => {
	const network = ipv6ToGroups("2001:db8::");
	assert.equal(cidr6Contains(ipv6ToGroups("2001:db8:ffff::1"), network, 32), true);
	assert.equal(cidr6Contains(ipv6ToGroups("2001:db9::1"), network, 32), false);
	// /33 sits inside the first bit of group 2: 2001:db8:8000:: is in, 2001:db8:7fff:: is not.
	assert.equal(cidr6Contains(ipv6ToGroups("2001:db8:7fff::1"), network, 33), true);
	assert.equal(cidr6Contains(ipv6ToGroups("2001:db8:8000::1"), network, 33), false);
	// /0 matches everything, /128 matches one address.
	assert.equal(cidr6Contains(ipv6ToGroups("2c0f:f7a8::1"), network, 0), true);
	assert.equal(cidr6Contains(network, network, 128), true);
	assert.equal(cidr6Contains(ipv6ToGroups("2001:db8::1"), network, 128), false);
	assert.equal(cidr6Contains(network, network, 129), false);
	assert.equal(cidr6Contains(network, network, -1), false);
});

test("embedded CN tables classify domestic and foreign targets", () => {
	assert.equal(inCnCidr4(ipv4ToInt("1.0.1.5")), true, "1.0.1.0/24 is in the embedded CN table");
	assert.equal(inCnCidr4(ipv4ToInt("9.9.9.9")), false);
	assert.equal(inCnCidr6(ipv6ToGroups("2001:250::1")), true, "2001:250::/30 is CN");
	assert.equal(inCnCidr6(ipv6ToGroups("2001:db8::1")), false, "documentation range is not CN");
	assert.equal(inCnCidr6(ipv6ToGroups("2c0f:f7a8:9020::1")), true, "last sorted entry still matches");
});

test("decide: domain, suffix, IP literal and trailing dot", () => {
	const engine = new RuleEngine();
	assert.equal(engine.decide("www.baidu.com"), "direct");
	assert.equal(engine.decide("BAIDU.COM"), "direct");
	assert.equal(engine.decide("baidu.com."), "direct", "FQDN trailing dot");
	assert.equal(engine.decide("www.google.com"), "proxy");
	assert.equal(engine.decide("1.0.1.5"), "direct");
	assert.equal(engine.decide("8.8.8.8"), "proxy");
	assert.equal(engine.decide("2001:250::1"), "direct");
	assert.equal(engine.decide("2001:db8::1"), "proxy");
	assert.equal(engine.decide("::ffff:1.0.1.5"), "direct", "IPv4-mapped CN address");
	assert.equal(engine.decide(""), "proxy");
	assert.equal(engine.decide("[2001:250::1]"), "direct", "bracketed literal");
});

test("decide: .cn shortcut and IDN", () => {
	const engine = new RuleEngine();
	assert.equal(engine.decide("some-unknown-host.cn"), "direct");
	assert.equal(engine.decide("中国.cn"), "direct", "IDN normalized to punycode, .cn suffix");
});

test("precedence: user > subscription > CN table > default", () => {
	const engine = new RuleEngine({
		extraRules: ["DOMAIN-SUFFIX,google.com,DIRECT", "DOMAIN,baidu.com,PROXY"],
		subscriptionRules: ["DOMAIN-SUFFIX,qq.com,DIRECT", "DOMAIN,baidu.com,DIRECT"],
		excludeRules: []
	});
	assert.equal(engine.decide("mail.google.com"), "direct", "user rule");
	assert.equal(engine.decide("baidu.com"), "proxy", "user rule beats subscription");
	assert.equal(engine.decide("www.qq.com"), "direct", "subscription passthrough");
	assert.equal(engine.decide("www.taobao.com"), "direct", "CN table");
	assert.equal(engine.decide("example.com"), "proxy");
});

test("excludeRules drop subscription entries only", () => {
	const engine = new RuleEngine({
		subscriptionRules: ["DOMAIN-SUFFIX,qq.com,DIRECT"],
		excludeRules: ["qq.com"]
	});
	assert.equal(engine.decide("www.example.com"), "proxy");
});

test("IP rules: precedence, boundaries and IPv4-mapped", () => {
	const engine = new RuleEngine({
		extraRules: ["IP-CIDR,8.8.8.0/24,REJECT", "IP-CIDR,192.168.1.0/31,PROXY", "IP-CIDR6,2001:db8::/32,DIRECT"]
	});
	assert.equal(engine.decide("8.8.8.8"), "reject");
	assert.equal(engine.decide("8.8.9.8"), "proxy", "outside the /24");
	assert.equal(engine.decide("::ffff:8.8.8.8"), "reject", "mapped IPv4 hits IPv4 rules");
	assert.equal(engine.decide("192.168.1.1"), "proxy");
	assert.equal(engine.decide("192.168.1.2"), "proxy", "outside /31, still default proxy");
	assert.equal(engine.decide("2001:db8:1::1"), "direct");
	assert.equal(engine.decide("2001:db9::1"), "proxy");
	// /0 matches every IPv4 but must not affect IPv6.
	const all = new RuleEngine({ extraRules: ["IP-CIDR,0.0.0.0/0,REJECT"] });
	assert.equal(all.decide("9.9.9.9"), "reject");
	assert.equal(all.decide("2001:db8::1"), "proxy");
});

test("GEOIP,CN matches both families", () => {
	const engine = new RuleEngine({ extraRules: ["GEOIP,CN,REJECT"] });
	assert.equal(engine.decide("1.0.1.5"), "reject");
	assert.equal(engine.decide("2001:250::1"), "reject");
	assert.equal(engine.decide("9.9.9.9"), "proxy");
	assert.equal(engine.decide("example.com"), "proxy");
});

test("malformed rules are reported, not swallowed", () => {
	const engine = new RuleEngine({
		extraRules: [
			"IP-CIDR,1.2.3.0/33,DIRECT",
			"IP-CIDR6,::1/129,PROXY",
			"IP-CIDR,1.2.3.4,DIRECT",
			"DOMAIN",
			"DOMAIN-SUFFIX,ok.example,DIRECT",
			"BOGUS-TYPE,x,DIRECT",
			"DOMAIN,x.example,SIDEWAYS"
		]
	});
	const lines = engine.diagnostics.map((entry) => entry.line);
	assert.equal(lines.length, 6, JSON.stringify(engine.diagnostics));
	assert.ok(lines.includes("IP-CIDR,1.2.3.0/33,DIRECT"));
	assert.ok(lines.includes("IP-CIDR6,::1/129,PROXY"));
	assert.ok(!lines.includes("DOMAIN-SUFFIX,ok.example,DIRECT"), "valid rule stays quiet");
	assert.equal(engine.decide("ok.example"), "direct", "valid neighbours still load");
});

test("no-resolve suffix and comments are accepted", () => {
	const engine = new RuleEngine({
		subscriptionRules: ["IP-CIDR,8.8.4.0/24,DIRECT,no-resolve", "# comment", "", "// comment"]
	});
	assert.equal(engine.diagnostics.length, 0);
	assert.equal(engine.decide("8.8.4.4"), "direct");
});

test("MATCH is a catch-all in declaration order", () => {
	const engine = new RuleEngine({ extraRules: ["DOMAIN,example.com,REJECT", "MATCH,PROXY"] });
	assert.equal(engine.decide("example.com"), "reject");
	assert.equal(engine.decide("anything.test"), "proxy");
});
