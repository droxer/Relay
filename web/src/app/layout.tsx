import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "@fontsource-variable/noto-sans/index.css";
import "@fontsource-variable/noto-sans-sc/index.css";
import "@fontsource-variable/noto-sans-tc/index.css";
import "../styles.css";

import { InlineScript } from "../components/InlineScript";
import { Providers } from "./providers";

// UI fonts ship from version-locked Fontsource packages. Their unicode-range
// subsets load on demand, including the SC/TC family selected by the pre-paint
// language. Builds and browsers do not need a Google Fonts connection.

// Technical text stays on the compact JetBrains Mono face already vendored by
// the application. Its Latin subset is sufficient because the locale-specific
// mono stacks retain native and Noto CJK fallbacks for Han glyphs.
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
      className={appMono.variable}
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
