/**
 * The founder's contact behind the business card's QR: the landing's "Save contact" is a vCard,
 * so one tap puts the name, number, email and LinkedIn into the phone that scanned the card.
 */

export interface CardContact {
  givenName: string;
  familyName: string;
  org: string;
  title: string;
  email: string;
  /** E.164, digits after the plus only (what tel: and wa.me want) */
  phoneE164: string;
  linkedin: string;
  site: string;
  note?: string;
}

/** `+17186643497` -> `+1 718 664 3497`, as printed on the card. Other lengths are left alone. */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** The vCard text; escaped per RFC 6350 and folded to CRLF lines. */
export function renderVCard(c: CardContact): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${esc(c.familyName)};${esc(c.givenName)};;;`,
    `FN:${esc(`${c.givenName} ${c.familyName}`.trim())}`,
    `ORG:${esc(c.org)}`,
    `TITLE:${esc(c.title)}`,
    `EMAIL;TYPE=INTERNET,WORK:${esc(c.email)}`,
    `TEL;TYPE=CELL,VOICE:${c.phoneE164}`,
    `URL:${c.site}`,
    `URL;TYPE=LinkedIn:${c.linkedin}`,
    `X-SOCIALPROFILE;TYPE=linkedin:${c.linkedin}`,
    ...(c.note ? [`NOTE:${esc(c.note)}`] : []),
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** RFC 6350 line folding: 75 octets, continuation lines start with one space. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (cut > 1 && Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** A filename the phone will show in its download sheet. */
export function vcardFilename(c: CardContact): string {
  return `${c.givenName}-${c.familyName}-${c.org}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".vcf";
}
