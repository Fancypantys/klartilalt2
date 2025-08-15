export const SITE = {
  // Use your current public URL on GitHub Pages (project site)
  // If/when you move to a custom domain, change this to e.g. "https://klartilalt.dk"
  website: "https://fancypantys.github.io/klartilalt2",

  author: "Kresten",
  // Optional: point to your profile (changed from the theme default)
  profile: "https://github.com/Fancypantys",

  desc: "Automatiseret præpping, beredskab og gear—artikler",
  title: "Klartilalt",

  // Don't include a leading slash here because your layout does `"/" + SITE.ogImage`
  // You already generate /og.png in the build, so use that by default.
  ogImage: "og.png",

  lightAndDarkMode: true,

  // Listing sizes
  postPerIndex: 4,
  postPerPage: 12,

  // Schedule/window
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes

  // UI toggles
  showArchives: true,
  showBackButton: true, // show back button in post detail

  // "Edit this page" link (point to your repo instead of the theme's)
  editPost: {
    enabled: true,
    text: "Edit page",
    url: "https://github.com/Fancypantys/klartilalt2/edit/main/",
  },

  dynamicOgImage: true,

  // Locale
  dir: "ltr",        // "rtl" | "auto"
  lang: "da",        // html lang code
  timezone: "Europe/Copenhagen", // IANA tz for your region
} as const;
