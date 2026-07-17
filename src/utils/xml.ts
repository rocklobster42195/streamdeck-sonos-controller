// Shared XML escaping/decoding for the five standard entities. Every action that builds SVG
// feedback and the DIDL-Lite metadata builders used to carry their own private copy of these —
// one implementation, used everywhere, keeps the entity set consistent.

export function escapeXml(s: string): string {
    return s.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
        }
    });
}

export function decodeXmlEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        // &amp; last, so a literal "&amp;lt;" decodes to "&lt;", not "<".
        .replace(/&amp;/g, '&');
}
