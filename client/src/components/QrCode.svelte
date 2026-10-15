<script lang="ts">
	import qrcode from "qrcode-generator";
	import PipayaLogo from "./PipayaLogo.svelte";

	let { value, size = 232 }: { value: string; size?: number } = $props();

	/**
	 * Error correction H survives losing 30% of the modules, so the logo in the middle can cover them.
	 * The logo plate stays under ~18% of the area: a margin for a scanner that sees the code at an angle.
	 */
	const PLATE = 0.24; // plate edge as a fraction of the code edge (0.24² ≈ 5.8% of the area)
	const QUIET = 2; // quiet zone, in modules

	const code = $derived.by(() => {
		const qr = qrcode(0, "H");
		qr.addData(value, "Byte");
		qr.make();
		return qr;
	});
	const count = $derived(code.getModuleCount());
	/** One path for all dark modules: small DOM, crisp at any scale */
	const path = $derived.by(() => {
		const half = (count * PLATE) / 2 + 0.5;
		const mid = count / 2;
		let d = "";
		for (let r = 0; r < count; r++) {
			let run = -1;
			for (let c = 0; c <= count; c++) {
				const dark = c < count && code.isDark(r, c) && !(Math.abs(r + 0.5 - mid) < half && Math.abs(c + 0.5 - mid) < half);
				if (dark && run < 0) run = c;
				else if (!dark && run >= 0) {
					d += `M${run + QUIET} ${r + QUIET}h${c - run}v1h${-(c - run)}z`;
					run = -1;
				}
			}
		}
		return d;
	});
	const view = $derived(count + QUIET * 2);
	const plate = $derived(Math.round(size * PLATE));
</script>

<div class="qr" style="width:{size}px;height:{size}px" role="img" aria-label={value ? "QR code" : ""}>
	<svg viewBox="0 0 {view} {view}" width={size} height={size} shape-rendering="crispEdges" aria-hidden="true">
		<rect width={view} height={view} fill="#fff" />
		<path d={path} fill="#111" />
	</svg>
	<span class="plate" style="width:{plate}px;height:{plate}px"><PipayaLogo size={Math.round(plate * 0.62)} /></span>
</div>

<style>
	.qr {
		position: relative;
		border-radius: 14px;
		overflow: hidden;
		background: #fff;
		/* a scanner needs a light background and dark modules whatever the theme is */
		color: #111;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08);
	}
	svg {
		display: block;
	}
	.plate {
		position: absolute;
		left: 50%;
		top: 50%;
		translate: -50% -50%;
		display: grid;
		place-items: center;
		border-radius: 28%;
		background: #fff;
		color: #111;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.07);
	}
</style>
