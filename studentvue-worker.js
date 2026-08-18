/**
 * StudentVUE Proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Deploy this for free at https://dash.cloudflare.com (Workers & Pages
 * → Create → paste this in the online editor → Deploy). No credit card
 * needed on the free plan.
 *
 * What it does: your app can't call StudentVUE's server directly from
 * the browser (it blocks cross-site requests, and StudentVUE only
 * speaks old-school SOAP/XML, not JSON). This Worker sits in between —
 * your app sends it a username/password/portal URL, it builds the SOAP
 * request, calls StudentVUE, and hands back plain JSON.
 *
 * This talks to the same unofficial, reverse-engineered endpoint the
 * official StudentVUE mobile app uses. It is not an endpoint Edupoint
 * (StudentVUE's maker) publishes or supports, so it could change or
 * break without notice.
 */

const ALLOWED_METHODS = {
    grades: "Gradebook",
    classes: "StudentClassList",
    studentinfo: "StudentInfo",
    schoolinfo: "StudentSchoolInfo",
};

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*", // tighten to your site's origin once it's live, e.g. "https://yoursite.com"
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function decodeEntities(str) {
    return str
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function normalizeBase(rawUrl) {
    // Accepts anything from "https://synergyweb.pusd11.net" to a full
    // login page URL, and reduces it to just the protocol + host.
    let u;
    try {
        u = new URL(rawUrl);
    } catch {
        u = new URL(`https://${rawUrl}`);
    }
    return `${u.protocol}//${u.host}`;
}

function extractSoapResult(xmlEnvelope) {
    const match = xmlEnvelope.match(
        /<ProcessWebServiceRequestResult>([\s\S]*?)<\/ProcessWebServiceRequestResult>/
    );
    if (!match) return null;
    return decodeEntities(match[1]);
}

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders() });
        }
        if (request.method !== "POST") {
            return jsonResponse({ error: "Use POST." }, 405);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: "Invalid JSON body." }, 400);
        }

        const { username, password, portalUrl, method } = body;
        if (!username || !password || !portalUrl || !method) {
            return jsonResponse(
                { error: "Missing one of: username, password, portalUrl, method." },
                400
            );
        }

        const methodName = ALLOWED_METHODS[method];
        if (!methodName) {
            return jsonResponse(
                { error: `Unknown method "${method}". Use one of: ${Object.keys(ALLOWED_METHODS).join(", ")}` },
                400
            );
        }

        const paramStr =
            method === "classes"
                ? "<Parms><childIntID>0</childIntID></Parms>"
                : "<Parms><ChildIntID>0</ChildIntID></Parms>";

        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ProcessWebServiceRequest xmlns="http://edupoint.com/webservices/"><userID>${escapeXml(
            username
        )}</userID><password>${escapeXml(
            password
        )}</password><skipLoginLog>1</skipLoginLog><parent>0</parent><webServiceHandleName>PXPWebServices</webServiceHandleName><methodName>${methodName}</methodName><paramStr>${escapeXml(
            paramStr
        )}</paramStr></ProcessWebServiceRequest></soap:Body></soap:Envelope>`;

        let base;
        try {
            base = normalizeBase(portalUrl);
        } catch {
            return jsonResponse({ error: "Couldn't understand that portal URL." }, 400);
        }

        let upstreamResp;
        try {
            upstreamResp = await fetch(`${base}/Service/PXPCommunication.asmx`, {
                method: "POST",
                headers: {
                    "Content-Type": "text/xml; charset=utf-8",
                    SOAPAction: "http://edupoint.com/webservices/ProcessWebServiceRequest",
                },
                body: soapBody,
            });
        } catch (err) {
            return jsonResponse(
                { error: "Couldn't reach the StudentVUE server. Check the portal URL." },
                502
            );
        }

        const rawXml = await upstreamResp.text();
        const resultXml = extractSoapResult(rawXml);

        if (!resultXml) {
            return jsonResponse(
                { error: "Unexpected response from StudentVUE. The login or portal URL may be wrong." },
                502
            );
        }

        // A failed login still returns HTTP 200 with an ErrorMessage in the XML.
        const errorMatch = resultXml.match(/ErrorMessage="([^"]*)"/);
        if (errorMatch && errorMatch[1]) {
            return jsonResponse({ error: errorMatch[1] }, 401);
        }

        return jsonResponse({ xml: resultXml });
    },
};