import test from "node:test";
import assert from "node:assert/strict";
import { esc, isHttpUrl } from "../public/escape.js";

test("esc neutralises HTML metacharacters", () => {
  assert.equal(
    esc(`<img src=x onerror="alert('x')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;",
  );
  assert.equal(esc("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});

test("isHttpUrl only accepts absolute http(s) URLs", () => {
  assert.equal(isHttpUrl("http://svc.local:8080/"), true);
  assert.equal(isHttpUrl("https://example.com"), true);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isHttpUrl("/relative/path"), false);
  assert.equal(isHttpUrl("not a url"), false);
});
