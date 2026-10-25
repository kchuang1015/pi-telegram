import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression tests for the steer (插話) delivery path.
 *
 * `pi.sendUserMessage()` is fire-and-forget: it returns void and pi routes
 * delivery errors to the extension error channel. The bridge therefore has to
 * wait for pi's `input` event before it may claim that a steer was inserted.
 * These tests drive the bridge with a mocked pi runtime that can confirm,
 * drop or throw on delivery.
 */

async function waitFor(predicate, timeoutMs = 8000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition timed out");
}

/**
 * @param delivery "confirm"     → pi accepts the steer and emits the input event
 *                 "drop"        → pi silently drops the steer (e.g. compaction)
 *                 "throw"       → pi throws synchronously
 *                 "idle"        → pi accepts, but the turn had ended and a new run starts
 *                 "idle-no-run" → pi accepts the input but never starts a run
 */
async function setup({ delivery = "confirm" } = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-telegram-steer-"));
	process.env.HOME = home;
	const dir = join(home, ".pi", "agent");
	await mkdir(join(dir, "sessions"), { recursive: true });
	await writeFile(join(dir, "telegram.json"), JSON.stringify({ botToken: "test", allowedUserId: 7, lastUpdateId: 0 }));

	const calls = [];
	let updates = [];
	globalThis.fetch = async (url, init = {}) => {
		const method = String(url).split("/").pop();
		let body = {};
		try {
			body = JSON.parse(init.body);
		} catch {}
		calls.push({ method, body });
		if (method === "getUpdates") {
			const batch = updates;
			updates = [];
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 3);
				init.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				}, { once: true });
			});
			if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
			return Response.json({ ok: true, result: batch });
		}
		return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: 99 } : true });
	};

	const { default: extension } = await import("./index.ts?steer=" + Math.random());
	const handlers = {};
	const commands = {};
	const sent = [];
	const attempts = [];
	let idle = true;
	const models = [{ provider: "test-provider", id: "model-a", contextWindow: 4096 }];
	const ctx = {
		isIdle: () => idle,
		model: models[0],
		cwd: home,
		modelRegistry: {
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
			isUsingOAuth: () => false,
		},
		getContextUsage: () => ({ tokens: 123, contextWindow: 4096, percent: 3 }),
		sessionManager: { getEntries: () => [], getSessionFile: () => "/current.json", getSessionDir: () => join(dir, "sessions") },
		ui: { theme: { fg: (_c, s) => s }, setStatus() {} },
	};
	const pi = {
		on: (n, fn) => (handlers[n] = fn),
		registerCommand: (n, c) => (commands[n] = c),
		registerTool() {},
		sendUserMessage: (content, opts) => {
			attempts.push({ content, opts });
			// Only the steer path is broken by the `delivery` mode; queued turns
			// (deliverAs: "followUp") keep working.
			if (opts?.deliverAs === "steer") {
				if (delivery === "throw") throw new Error("extension is not active");
				if (delivery === "drop") return;
			}
			sent.push({ content, opts });
			const text = Array.isArray(content)
				? content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
				: content;
			if (opts?.deliverAs === "steer") {
				void handlers.input?.({
					type: "input",
					text,
					source: "extension",
					streamingBehavior: delivery === "idle" || delivery === "idle-no-run" ? undefined : "steer",
				});
				if (delivery === "idle") {
					// pi turned the message into a new run.
					setTimeout(() => void handlers.agent_start?.({}, ctx), 5);
				}
			} else {
				// pi emits an input event for queued turns as well, and the
				// delivery starts a new run.
				void handlers.input?.({ type: "input", text, source: "extension", streamingBehavior: undefined });
				setTimeout(() => void handlers.agent_start?.({}, ctx), 5);
			}
		},
	};
	extension(pi);
	await handlers.session_start({}, ctx);
	await new Promise((r) => setTimeout(r, 20));

	return {
		home,
		calls,
		handlers,
		ctx,
		sent,
		attempts,
		connect: () => commands["telegram-connect"].handler("", ctx),
		setIdle: (v) => (idle = v),
		setUpdates: (v) => (updates = v),
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

const message = (id, text) => ({ message_id: id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "A" }, text });

const sentText = (calls) =>
	calls
		.filter((c) => ["sendMessage", "editMessageText", "sendRichMessage"].includes(c.method))
		.map((c) => c.body.text ?? c.body.rich_message?.markdown ?? "")
		.join("\n");

test("a confirmed steer is reported as inserted", { timeout: 90000 }, async () => {
	const h = await setup({ delivery: "confirm" });
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "插話內容") }]);
		await waitFor(() => sentText(h.calls).includes("已插入目前工作"));
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].content, "插話內容");
		assert.equal(h.sent[0].opts.deliverAs, "steer");
		assert.ok(!sentText(h.calls).includes("插話未送達"), "a confirmed steer must not be reported as failed");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("a steer that pi drops is reported as failed and queued instead of lost", { timeout: 90000 }, async () => {
	const h = await setup({ delivery: "drop" });
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "會被丟棄的插話") }]);
		await waitFor(() => sentText(h.calls).includes("插話未送達"), 30000);
		assert.ok(!sentText(h.calls).includes("已插入目前工作"), "a dropped steer must never be reported as inserted");
		assert.equal(h.sent.length, 0, "a dropped steer must not be pushed to pi again while the turn runs");

		// The queued turn is delivered once the running turn ends.
		await h.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] }, h.ctx);
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.sent[0].opts.deliverAs, "followUp");
		assert.ok(
			JSON.stringify(h.sent[0].content).includes("會被丟棄的插話"),
			"the dropped message must survive in the queue",
		);
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("a steer that throws synchronously is reported as failed and queued", async () => {
	const h = await setup({ delivery: "throw" });
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "拋錯的插話") }]);
		await waitFor(() => sentText(h.calls).includes("插話未送達"), 30000);
		assert.ok(!sentText(h.calls).includes("已插入目前工作"));
		assert.ok(sentText(h.calls).includes("extension is not active"), "the underlying reason must be reported");
		assert.equal(h.sent.length, 0);
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("a queued turn delivered while a steer is pending is not mistaken for the steer confirmation", { timeout: 90000 }, async () => {
	const h = await setup({ delivery: "drop" });
	try {
		await h.connect();
		h.setIdle(false);
		// 1st steer: dropped by pi -> falls back to the queue.
		h.setUpdates([{ update_id: 1, message: message(1, "abc") }]);
		await waitFor(() => sentText(h.calls).includes("插話未送達"), 30000);
		// 2nd steer: pending, pi never confirms it.
		h.setUpdates([{ update_id: 2, message: message(2, "abc") }]);
		await waitFor(() => h.attempts.length === 2, 10000);
		// The running turn ends -> the queued turn (which contains "abc") is
		// delivered and produces its own input event. That event must not be
		// taken for the confirmation of the pending steer.
		await h.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] }, h.ctx);
		await waitFor(() => h.sent.length === 1, 10000);
		await waitFor(() => sentText(h.calls).split("插話未送達").length === 3, 30000);
		assert.ok(!sentText(h.calls).includes("已插入目前工作"), "the pending steer must not be confirmed by our own delivery");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("a steer handed over after the turn ended is not reported as an insertion", { timeout: 90000 }, async () => {
	const h = await setup({ delivery: "idle" });
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "剛好結束的插話") }]);
		await waitFor(() => sentText(h.calls).includes("新的一輪"), 30000);
		assert.ok(!sentText(h.calls).includes("已插入目前工作"), "the message did not steer a running turn");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].opts.deliverAs, "steer");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("a steer that never starts a run is reported as failed and queued", { timeout: 90000 }, async () => {
	const h = await setup({ delivery: "idle-no-run" });
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "沒有回合的插話") }]);
		await waitFor(() => sentText(h.calls).includes("插話未送達"), 30000);
		assert.ok(!sentText(h.calls).includes("已插入目前工作"));
		assert.ok(!sentText(h.calls).includes("新的一輪"), "no run started, so the message was not delivered");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});
