import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "../styles.css";

import { InlineScript } from "../components/InlineScript";
import { Providers } from "./providers";

// One sans carries every role — reading, control, and display — with
// hierarchy built from size and weight (400/500/700) rather than from a
// second face. The source system's own face is Optimistic VF, which Meta does not
// license for redistribution: palette.css names it first for anyone who has
// it installed, and IBM Plex Sans (loaded here) is the variable file this app
// actually ships behind it. JetBrains Mono remains for technical text only:
// session IDs, logs, and code, set 400 untracked. Both are local variable
// fonts to avoid layout drift.
//
// The vendored WOFF2 is fontsource's latin subset of IBM Plex Sans
// (@fontsource-variable/ibm-plex-sans 5.3.0, OFL-1.1, wght 100–700). Latin
// covers U+00C0–00FF, so accented names render in-face; latin-ext glyphs fall
// through to the system sans by design rather than shipping a second file.
// The same arrangement holds for JetBrains Mono (fontsource 5.3.0, OFL-1.1,
// wght 100–800).
//
// CJK stays system-first (PingFang / YaHei / etc. in palette.css). We do
// not load Noto Sans SC/TC through next/font — those unicode-range chunks
// balloon Turbopack compile and only matter on bare Linux.
const appSans = localFont({
  src: "./fonts/IBMPlexSans-Variable.woff2",
  variable: "--font-app-sans",
  display: "swap",
  weight: "100 700",
  style: "normal",
});

const appMono = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-app-mono",
  display: "swap",
  weight: "100 800",
  style: "normal",
});

export const metadata: Metadata = {
  title: "Relay",
  description: "Nodes, daemons, and agent runs.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: "/favicon.svg",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  viewportFit: "cover",
};

const themeScript = `(function(){try{
  var root=document.documentElement;
  var l=localStorage.getItem("relay-web.language");
  if(l==="en"||l==="zh-CN"||l==="zh-TW")root.setAttribute("lang",l);
  var t=localStorage.getItem("relay-web.theme")||"system";
  if(t==="contrast"||t==="contrast-dark"){t="system";localStorage.setItem("relay-web.theme","system");}
  var d=matchMedia("(prefers-color-scheme: dark)").matches;
  var r=(t==="dark"||(t!=="light"&&d))?"dark":"light";
  root.setAttribute("data-theme",r);
  var sync=function(){
    var color=getComputedStyle(root).getPropertyValue("--surface-0").trim();
    if(!color)return false;
    var meta=document.querySelector('meta[name="theme-color"][data-relay-theme-color]');
    if(!meta){
      meta=document.createElement("meta");
      meta.setAttribute("name","theme-color");
      meta.setAttribute("data-relay-theme-color","");
      document.head.appendChild(meta);
    }
    meta.removeAttribute("media");
    meta.setAttribute("content",color);
    return true;
  };
  if(!sync())document.addEventListener("DOMContentLoaded",sync,{once:true});
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  // The default language is English; the client App updates both
  // document.documentElement.lang and document.title from the user's
  // saved preference once it hydrates.
  return (
    <html
      lang="en"
      className={`${appMono.variable} ${appSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Resolve the saved language and theme before first paint, then derive
            browser chrome from the same canvas token as the rendered page. */}
        <InlineScript html={themeScript} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
