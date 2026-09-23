# Interface identity

`interface-icon.png` is the production raster mark. It is used by the workbench, browser favicon, touch icon, and Electron Dock/window configuration. The source image is 1254 × 1254 pixels. Keep this file in the repository; no generated asset outside the checkout is required at runtime.

The identity uses a lowercase **i** with two complementary parts: a sage upper module and an ivory stem with an offset shoulder. It accompanies the live lowercase wordmark **interface**. The form represents the handoff between an instruction and its execution, while fitting the workbench's existing forest-green palette.

Palette targets: forest `#294B3A`, ivory `#F6F4E9`, sage `#C7DA9D`. The PNG is an opaque square; the interface gives it rounded corners through CSS. The wordmark stays live text for crisp rendering and an accessible workspace link.

## Generation provenance

Created using Codex's built-in image-generation tool. No project API key or fallback CLI was used. The final asset is an opaque refinement of the initial generated mark, removing the initial background-transparency defects.

Final refinement prompt:

> Make an OPAQUE version of this logo. Do NOT create any transparent pixels. Do NOT remove a background. Fill the ENTIRE square image canvas edge to edge with one flat, solid, fully opaque forest green #294B3A. No rounded-square outer boundary is needed: the whole square is green. Preserve the exact central two-piece lowercase i design and proportions: sage upper piece #C7DA9D, ivory lower piece #F6F4E9. The background must be UNIFORMLY solid green everywhere behind the mark including the left and right sides. No black patches, no glow, no shadow, no gradient, no lighting, no texture, no soft edges. This is a flat screen-printed three-color corporate logo, not a 3D app icon. All pixels fully opaque. Return the single square logo asset, no text.

To apply frontend changes to a running workbench, rebuild with `npm run build` and reload its view. Native Dock icon changes apply on the next desktop launch. Finish or stop active runs before restarting the worker.
