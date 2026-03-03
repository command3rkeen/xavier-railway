import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * G2X Knowledge Base — Quartz v4 configuration.
 *
 * Quartz renders the vault as a static site. This config excludes private
 * directories (xavier/, personal/) so only company/ content is publicly
 * browsable on the tailnet.
 *
 * @see https://quartz.jzhao.xyz/configuration
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "G2X Knowledge Base",
    pageTitleSuffix: " — G2X",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "en-US",
    baseUrl: "xavier.tail96b72e.ts.net/kb",
    ignorePatterns: [
      "xavier/**",
      "personal/**",
      ".silverbullet*",
      "SETTINGS.md",
      "node_modules",
      ".obsidian",
    ],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Inter",
        body: "Inter",
        code: "JetBrains Mono",
      },
      colors: {
        lightMode: {
          light: "#fafafa",
          lightgray: "#e5e5e5",
          gray: "#8b8b8b",
          darkgray: "#2d2d2d",
          dark: "#1a1a2e",
          secondary: "#0f4c81",
          tertiary: "#1a73e8",
          highlight: "rgba(15, 76, 129, 0.1)",
          textHighlight: "#fff23688",
        },
        darkMode: {
          light: "#161618",
          lightgray: "#2a2a2e",
          gray: "#646468",
          darkgray: "#d4d4d4",
          dark: "#ebebec",
          secondary: "#4da6ff",
          tertiary: "#70baff",
          highlight: "rgba(77, 166, 255, 0.12)",
          textHighlight: "#fff23633",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({ priority: ["frontmatter", "filesystem"] }),
      Plugin.SyntaxHighlighting({ theme: { light: "github-light", dark: "github-dark" } }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({ enableSiteMap: true, enableRSS: true }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
