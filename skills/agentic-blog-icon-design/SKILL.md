---
name: agentic-blog-icon-design
description: Design and integrate a compact Agentic Blog icon or favicon using a rasterized visual-review loop. Use for blog brand marks, favicons, and header icons; not for post illustrations or diagrams.
---

# Agentic Blog Icon Design

Create small blog marks as SVGs, but judge them from browser-rasterized output before they enter managed content.

1. Work on candidate SVGs in an isolated temporary directory. Do not write a candidate to `static_content/` yet.
2. Render every candidate with `node skills/agentic-blog-icon-design/scripts/render-review.mjs --svg <candidate.svg> --out <temporary-directory>`. Inspect the four PNGs: `light-full.png`, `dark-full.png`, `light-favicon.png`, and `dark-favicon.png`.
3. Check intended meaning, light/dark visibility, visual balance, stroke alignment, clipping, and recognition at native 16 px. Revise the SVG and repeat the render-and-review loop until all checks pass; do not accept a failing candidate.
4. When delegation is available, request a clean-room visual-semiotics review from an agent that receives only the four rendered images and a minimal usage statement. Treat material confusing, negative, or exclusionary readings as a failed review and iterate again.
5. Use the Content MCP for every `static_content/` read or mutation. After visual approval, write only the final SVG through `write_asset`; never edit content files directly.
6. For engine changes such as a header mark or favicon link, use Preview MCP to inspect desktop and phone pages. Follow the content skill's explicit-approval requirement before publishing.

The renderer needs the workspace's Playwright dependency. If it is unavailable, restore project dependencies before reviewing; do not substitute an uninspected SVG.
