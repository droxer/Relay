import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import "../styles.css";

import { InlineScript } from "../components/InlineScript";
import en from "../i18n/locales/en/translation.json";
import { SITE_NAME, SITE_SHARE_IMAGE, jsonLdScript, siteUrl, softwareJsonLd } from "../lib/site";
import { SIGNED_IN_HINT_KEY } from "../lib/appStorage";
import { apiOrigin, relayApiEndpoint } from "../lib/apiOrigin";
import { earlyAuthProbeScript } from "../lib/earlyAuthProbe";
import { LANDING_HERO_SHOT, LANDING_HERO_SIZES, landingShotSrc, landingShotSrcSet } from "../lib/landing";
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
// The card states the landing headline, so its alt text is that headline.
const shareImage = { ...SITE_SHARE_IMAGE, alt: `${SITE_NAME}: ${en.landing.headline}` };

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

// The landing page renders client-side, so its hero image is unknown to the
// HTML until the page's code runs. Name the right cut (theme x language) up
// front for a visitor who will see it: at `/`, not signed in last time.
const heroCut = (theme: "dark" | "light", language: string) => [
  landingShotSrc(LANDING_HERO_SHOT, language, theme),
  landingShotSrcSet(LANDING_HERO_SHOT, language, theme),
];
const heroCuts = JSON.stringify({
  dark: { en: heroCut("dark", "en"), "zh-CN": heroCut("dark", "zh-CN") },
  light: { en: heroCut("light", "en"), "zh-CN": heroCut("light", "zh-CN") },
});

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
  var p=location.pathname;
  if((p==="/"||p==="")&&localStorage.getItem(${JSON.stringify(SIGNED_IN_HINT_KEY)})!=="1"){
    var h=${heroCuts}[r][l==="zh-CN"?"zh-CN":"en"];
    var k=document.createElement("link");
    k.rel="preload";k.as="image";k.href=h[0];
    k.setAttribute("imagesrcset",h[1]);
    k.setAttribute("imagesizes",${JSON.stringify(LANDING_HERO_SIZES)});
    k.setAttribute("fetchpriority","high");
    document.head.appendChild(k);
  }
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
  ${earlyAuthProbeScript(relayApiEndpoint("/auth/me"), SIGNED_IN_HINT_KEY)}
}catch(e){}})();`;

// A UI hosted apart from its API (NEXT_PUBLIC_RELAY_API_ORIGIN) reaches a
// second host: open that connection while the page's own code downloads. The
// requests are credentialed, which is the pool a plain preconnect warms.
const apiPreconnect = apiOrigin();

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
        {apiPreconnect ? <link rel="preconnect" href={apiPreconnect} /> : null}
        <InlineScript html={themeScript} />
        {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
