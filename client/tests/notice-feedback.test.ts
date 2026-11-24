import { describe, expect, test } from "bun:test";
import { compile } from "svelte/compiler";

const read = (rel: string) => Bun.file(`src/components/${rel}`).text();

describe("notice and completion feedback consistency", () => {
	test("all updated components compile cleanly", async () => {
		const files = [
			"chat/AssistantMessage.svelte",
			"server/Backup.svelte",
			"server/RetentionSection.svelte",
			"settings/VoicePane.svelte",
			"settings/NotificationSettings.svelte",
			"shell/NoServer.svelte",
			"models/ModelConnections.svelte",
			"extensions/PermissionList.svelte",
			"extensions/InstalledDetail.svelte",
			"extensions/ServerDetail.svelte",
			"agent/TemplatesPanel.svelte",
			"extensions/Marketplace.svelte",
			"server/ConnectModal.svelte",
			"settings/UpdateSettings.svelte",
			"settings/GuardPane.svelte",
		];
		for (const f of files) {
			const src = await read(f);
			expect(() => compile(src, { filename: f, generate: "client" }), f).not.toThrow();
		}
	});

	test("AssistantMessage cut notice keeps md size regardless of resume button", async () => {
		const src = await read("chat/AssistantMessage.svelte");
		const cut = src.match(/<div class="cut">[\s\S]*?<\/div>/)?.[0] ?? "";
		const notices = cut.match(/<Notice\b[^>]*>/g) ?? [];
		expect(notices).toEqual(['<Notice tone="warn" role="status">']);
		expect(cut).toContain("{#if actions.resume}");
	});

	test("Backup, RetentionSection, VoicePane, and ModelConnections report routine completions/errors via toast", async () => {
		const backup = await read("server/Backup.svelte");
		expect(backup).toContain('app.toast(t("서버 {servers}개 · 단축키 {keys}개를 파일로 저장했습니다"');
		expect(backup).toContain('app.toast(`${t("가져왔습니다.")} ${summary}`, "ok")');
		expect(backup).toContain('app.toast(t("가져오기 전 상태로 되돌렸습니다. 확장은 모두 꺼진 상태입니다."), "ok")');
		expect(backup).not.toContain('tone="ok"');

		const retention = await read("server/RetentionSection.svelte");
		expect(retention).toContain('app.toast(t("{n}개를 지웠습니다.", { n: deleted }), "ok")');
		expect(retention).not.toContain('role="status"');

		const voice = await read("settings/VoicePane.svelte");
		expect(voice).toContain('if (!silent) app.toast(t("저장했습니다"), "ok")');
		expect(voice).toContain('if (result.ok) app.toast(result.message, "ok")');
		expect(voice).toContain('onclick={() => void save()}');
		expect(voice).not.toContain("onclick={save}");
		expect(voice).toContain('<Notice tone="danger" size="sm" raised animated>{error}</Notice>');

		const models = await read("models/ModelConnections.svelte");
		expect(models).toContain('app.toast(t("삭제하지 못했습니다: {error}", { error: errorText(e) }), "error")');
		expect(models).not.toContain("actionError");
	});

	test("NoServer shows startHere/scan errors outside the scan-only branch at md size", async () => {
		const src = await read("shell/NoServer.svelte");
		const ways = src.match(/<div class="ways">[\s\S]*?<\/div>/)?.[0] ?? "";
		const scanEnd = ways.indexOf("{/if}", ways.indexOf('ways.includes("scan")'));
		const errPos = ways.indexOf('<Notice tone="danger" animated>{error}</Notice>');
		expect(scanEnd).toBeGreaterThan(-1);
		expect(errPos).toBeGreaterThan(scanEnd);
		expect(ways).not.toContain('size="sm"');
	});

	test("extension details, permission list, templates, modals, and update settings use consistent Notice props", async () => {
		const installed = await read("extensions/InstalledDetail.svelte");
		const instNotices = installed.match(/<div class="notices">[\s\S]*?<\/div>/)?.[0] ?? "";
		expect(instNotices).not.toContain('size="sm"');
		expect(installed).toContain("<PermissionList pkg={entry.package} raised />");

		const server = await read("extensions/ServerDetail.svelte");
		const srvNotices = server.match(/<div class="notices">[\s\S]*?<\/div>/)?.[0] ?? "";
		expect(srvNotices).not.toContain('size="sm"');
		expect(server).toContain('<Notice tone="warn" size="sm" raised role="status">{form.problem}</Notice>');
		expect(server).toContain('<Notice tone="warn" role="status">{t("확장이 보낸 화면을 표시하지 못했습니다.")}</Notice>');

		const templates = await read("agent/TemplatesPanel.svelte");
		expect(templates).toContain("raised={!bare}");

		const market = await read("extensions/Marketplace.svelte");
		expect(market).toContain('<Notice tone="danger" animated role="alert">{error}</Notice>');

		const connect = await read("server/ConnectModal.svelte");
		expect(connect).toContain('<Notice tone="danger" animated>{error}</Notice>');
		expect(connect).toContain('<Notice tone="danger" animated>{login.error}</Notice>');

		const update = await read("settings/UpdateSettings.svelte");
		expect(update).toContain('<div class="err-gap" in:collapseIn out:collapseOut><Notice tone="danger" size="sm" raised>{updater.error}</Notice></div>');

		const guard = await read("settings/GuardPane.svelte");
		expect(guard).toContain('<Notice tone="danger" size="sm" raised animated>{error}</Notice>');
	});
});
