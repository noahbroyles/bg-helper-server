import { JSDOM } from "jsdom";
import { Elysia, t } from "elysia";
import { WebPoMinter } from "bgutils-js/webpo";
import { BotGuardClient } from "bgutils-js/botguard";
import { serverTiming } from "@elysiajs/server-timing";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from "bgutils-js/utils";

// BotGuard runs in this page, which looks like it is on youtube.com
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
	url: "https://www.youtube.com/",
	referrer: "https://www.youtube.com/",
});

Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	location: dom.window.location,
	origin: dom.window.origin,
});

if (!("navigator" in globalThis)) {
	Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
}

type CachedMinter = {
	minter: Promise<WebPoMinter>;
	// When to make a new one, in ms since the epoch; Infinity while it is still being made
	refreshAt: number;
};

// One minter per request key. Its integrity token stays valid for a long time, so it mints many tokens.
const minters = new Map<string, CachedMinter>();

/**
 * Runs YouTube's BotGuard challenge and makes a minter from the integrity token it earns.
 *
 * The challenge comes from the youtube.com homepage, and BotGuard runs with that page's ytcfg. Tokens
 * minted from a challenge of the Create endpoint instead are no longer accepted for streaming:
 * googlevideo reports the attestation as pending and stops sending media after the first minute.
 *
 * @returns the minter, and for how many ms to use it
 */
async function createMinter(requestKey: string): Promise<{ minter: WebPoMinter; lifetimeMs: number }> {
	const pageHtml = await fetch("https://www.youtube.com/", {
		headers: {
			accept: "*/*",
			"accept-language": "en-US,en;q=0.7",
			"user-agent": USER_AGENT,
		},
	}).then((response) => response.text());

	const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
	if (!ytConfig) throw new Error("Could not find ytcfg in the homepage");

	// BotGuard reads EVENT_ID from yt.config_
	const yt = { config_: JSON.parse(ytConfig) };
	Object.assign(dom.window, { yt });
	Object.assign(globalThis, { yt });

	const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
	if (!attestation) throw new Error("Could not find the BotGuard challenge in the homepage");

	const challenge = parseLooseJSON(attestation).R?.bgChallenge;
	const interpreterUrl = challenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
	if (!challenge?.program || !interpreterUrl) throw new Error("Could not get the BotGuard challenge");

	// Loads the BotGuard VM
	new Function(await fetch(`https:${interpreterUrl}`).then((response) => response.text()))();

	const botGuardClient = await BotGuardClient.create({
		program: challenge.program,
		globalName: challenge.globalName,
		globalObject: globalThis,
	});

	const webPoSignalOutput: WebPoSignalOutput = [];
	const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

	const response = await fetch(buildURL("GenerateIT", true), {
		method: "POST",
		headers: getHeaders(),
		body: JSON.stringify([requestKey, botguardResponse]),
	});
	if (!response.ok) throw new Error(`GenerateIT failed with status ${response.status}`);

	const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
		(await response.json()) as [string, number, number, string];

	const minter = await WebPoMinter.create(
		{ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
		webPoSignalOutput,
	);

	// Make a new minter mintRefreshThreshold seconds before the integrity token expires, but keep each for at least a minute
	const lifetimeSecs = Math.max((estimatedTtlSecs || 0) - (mintRefreshThreshold || 0), 60);
	console.log(`Made a WebPO minter for request key ${requestKey}, using it for ${lifetimeSecs} s`);

	return { minter, lifetimeMs: lifetimeSecs * 1000 };
}

/**
 * @returns the cached minter for requestKey, or a new one if there is none or it is due for a refresh
 */
function getMinter(requestKey: string): Promise<WebPoMinter> {
	const cached = minters.get(requestKey);
	if (cached && Date.now() < cached.refreshAt) return cached.minter;

	const created = createMinter(requestKey);
	// Requests that come in while it is being made wait for the same one
	const entry: CachedMinter = { minter: created.then(({ minter }) => minter), refreshAt: Infinity };
	minters.set(requestKey, entry);

	created.then(
		({ lifetimeMs }) => {
			entry.refreshAt = Date.now() + lifetimeMs;
		},
		() => {
			// Try again on the next request
			if (minters.get(requestKey) === entry) minters.delete(requestKey);
		},
	);

	return entry.minter;
}

const app = new Elysia()
	.use(serverTiming())
	.post(
		"/generate",
		// visitorData is what the token is bound to: visitor data for a session-bound token, or a video ID for a content-bound one
		async ({ body: { visitorData, requestKey } }) => {
			const minter = await getMinter(requestKey);

			try {
				return {
					poToken: await minter.mintAsWebsafeString(visitorData),
					visitorData,
				};
			} catch (e) {
				// The minter may have gone bad, so make a new one for the next request
				const cached = minters.get(requestKey);
				if (cached && (await cached.minter.catch(() => undefined)) === minter) minters.delete(requestKey);
				throw e;
			}
		},
		{
			body: t.Object({
				requestKey: t.String({
					default: "O43z0dpjhgX20SCx4KAo",
				}),
				visitorData: t.String(),
			}),
		},
	)
	.listen(3000);

console.log("Server started at http://0.0.0.0:3000");
