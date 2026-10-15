import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "../styles.css";

import { InlineScript } from "../components/InlineScript";
import en from "../i18n/locales/en/translation.json";
import { SITE_NAME, SITE_SHARE_IMAGE, jsonLdScript, siteUrl, softwareJsonLd } from "../lib/site";
import { Providers } from "./providers";

// The reading face is the platform's own UI face (see --font-sans in
// styles/tokens/palette.css), so no sans web font is loaded.

// Technical text stays on the compact JetBrains Mono face already vendored by
// the application. Its Latin subset is sufficient because the mono stacks
// retain native and Noto CJK fallbacks for Han glyphs.
const appMono = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-app-mono",
  display: "swap",
  weight: "100 800",
  style: "normal",
});

// Search and link previews describe the signed-out landing page, in English:
// the export is one HTML file, so it carries one language. Only a build that
// declares its public address (NEXT_PUBLIC_RELAY_SITE_URL) is indexable; see
// lib/site.ts.
const site = siteUrl();
const pageTitle = en.landing.page_title;
const pageDescription = en.landing.lede;
const shareImage = { ...SITE_SHARE_IMAGE, alt: en.landing.hero_alt };

export const metadata: Metadata = {
  ...(site ? { metadataBase: site } : {}),
  title: pageTitle,
  description: pageDescription,
  applicationName: SITE_NAME,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: "/favicon.svg",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  robots: site ? { index: true, follow: true } : { index: false, follow: false },
  ...(site
    ? {
        alternates: { canonical: "/" },
        openGraph: {
          type: "website",
          url: "/",
          siteName: SITE_NAME,
          title: pageTitle,
          description: pageDescription,
          locale: "en_US",
          alternateLocale: ["zh_CN"],
          images: [shareImage],
        },
        twitter: {
          card: "summary_large_image",
          title: pageTitle,
          description: pageDescription,
          images: [shareImage],
        },
      }
    : {}),
};

const jsonLd = site ? jsonLdScript(softwareJsonLd(site, pageDescription)) : null;

export const viewport: Viewport = {
  viewportFit: "cover",
};

const themeScript = `(function(){try{
  var root=document.documentElement;
  var l=localStorage.getItem("relay-web.language");
  if(l==="zh-TW")l="zh-CN";
  if(l==="en"||l==="zh-CN")root.setAttribute("lang",l);
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
        {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
