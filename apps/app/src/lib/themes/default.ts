export const defaultThemeCss = `
:root, .light {
  --border: color-mix(in oklab, var(--primary) 30%, var(--canvas));
  --border-hairline: color-mix(in oklab, var(--primary) 32%, var(--canvas));
  --border-seam: color-mix(in oklab, var(--primary) 26%, var(--canvas));
  --sidebar-border: color-mix(in oklab, var(--primary) 30%, var(--canvas));
  --input: color-mix(in oklab, var(--primary) 55%, var(--canvas));
  --timeline-accent: color-mix(in oklab, var(--primary) 80%, var(--ink));
  --file-accent: var(--timeline-accent);
}
.dark {
  --border: color-mix(in oklab, var(--primary) 34%, var(--canvas));
  --border-hairline: color-mix(in oklab, var(--primary) 36%, var(--canvas));
  --border-seam: color-mix(in oklab, var(--primary) 40%, var(--canvas));
  --sidebar-border: color-mix(in oklab, var(--primary) 34%, var(--canvas));
  --input: color-mix(in oklab, var(--primary) 60%, var(--canvas));
  --timeline-accent: var(--primary);
  --file-accent: var(--timeline-accent);
}
`;
