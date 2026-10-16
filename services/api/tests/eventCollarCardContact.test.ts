import { test } from "node:test";
import assert from "node:assert/strict";
import { prettyPhone, renderVCard, vcardFilename, type CardContact } from "../src/eventCollar/crossVenue/cardContact";

const C: CardContact = {
  givenName: "Michael",
  familyName: "William",
  org: "Atticus",
  title: "Founder",
  email: "michael@atticustrade.com",
  phoneE164: "+17186643497",
  linkedin: "https://www.linkedin.com/in/michael-william-5888ba263/",
  site: "https://event.earnandprotect.xyz/",
  note: "Earn & Protect. The Lock in button: a floor and cash now on any open position, hedged leg for leg.",
};

test("card: the vCard carries name, number, email, LinkedIn and the site, CRLF-terminated, folded at 75 octets", () => {
  const v = renderVCard(C);
  const lines = v.split("\r\n");
  assert.equal(lines.at(-1), "", "ends with CRLF");
  assert.equal(lines[0], "BEGIN:VCARD");
  assert.equal(lines[1], "VERSION:3.0");
  assert.equal(lines.at(-2), "END:VCARD");
  assert.ok(lines.includes("N:William;Michael;;;"));
  assert.ok(lines.includes("FN:Michael William"));
  assert.ok(lines.includes("ORG:Atticus") && lines.includes("TITLE:Founder"));
  assert.ok(lines.includes("TEL;TYPE=CELL,VOICE:+17186643497"));
  assert.ok(lines.includes("EMAIL;TYPE=INTERNET,WORK:michael@atticustrade.com"));
  assert.ok(lines.includes("URL:https://event.earnandprotect.xyz/"));
  assert.ok(lines.includes("URL;TYPE=LinkedIn:https://www.linkedin.com/in/michael-william-5888ba263/"));
  for (const l of lines) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `line within 75 octets: ${l}`);
  const noteStart = lines.findIndex((l) => l.startsWith("NOTE:"));
  assert.ok(noteStart > 0 && lines[noteStart + 1].startsWith(" "), "the long note is folded onto a continuation line");
  const unfolded = v.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("X-SOCIALPROFILE;TYPE=linkedin:https://www.linkedin.com/in/michael-william-5888ba263/\r\n"), "the social line is folded on the wire and whole once unfolded");
  assert.ok(unfolded.includes("NOTE:Earn & Protect. The Lock in button: a floor and cash now on any open position\\, hedged leg for leg."), "commas escaped; unfolding restores the text");
  assert.ok(!v.includes("\u2014"), "no em dash");
});

test("card: a contact without a note has no NOTE line; separators in names are escaped", () => {
  const v = renderVCard({ ...C, note: undefined, familyName: "Smith; Jones", org: "A, B" });
  assert.ok(!v.includes("NOTE:"));
  assert.ok(v.includes("N:Smith\\; Jones;Michael;;;"));
  assert.ok(v.includes("ORG:A\\, B"));
});

test("card: the printed number and the filename", () => {
  assert.equal(prettyPhone("+17186643497"), "+1 718 664 3497");
  assert.equal(prettyPhone("+447700900123"), "+447700900123", "other countries are left as written");
  assert.equal(vcardFilename(C), "michael-william-atticus.vcf");
});
