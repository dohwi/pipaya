// Example server extension: a declarative status page (works everywhere, needs no consent) and, optionally, Svelte for
// its own settings page (`pipaya.components`, runs only after the user allows it on that device). Not specific to anything.
export default (pi: any) => {
	let runs = 0;
	const show = () => pi.ui?.setPanel({
		type: "card", id: "status", title: { ko: "현재 상태", en: "Status" }, children: [
			{ type: "badge", id: "state", text: { ko: "● 동작 중", en: "● Running" }, tone: "success" },
			{ type: "stat", id: "runs", label: { ko: "실행 횟수", en: "Runs" }, value: String(runs) },
			{ type: "button", id: "run", label: { ko: "지금 실행", en: "Run now" } },
		],
	});
	pi.ui?.onEvent((e: any) => {
		if (e.type === "action" && e.id === "run") {
			runs++;
			pi.settings.set({ ...pi.settings.get(), status: { ko: `${runs}번 실행했습니다`, en: `Ran ${runs} time(s)` } });
			show();
		}
	});
	// a method the Svelte components call through `call("run")`
	pi.registerMethod("run", () => { runs++; show(); return runs; });
	show();
};
