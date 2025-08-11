export const SITE = {
  website: "https://klartilalt.dk/", // replace this with your deployed domain
  author: "Kresten",
  profile: "https://satnaing.dev/",
  desc: "Automatiseret præpping, beredskab og gear—artikler",
  title: "Klartilalt",
  ogImage: "/images/og.png",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 12,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: true,
    text: "Edit page",
    url: "https://github.com/satnaing/astro-paper/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr", // "rtl" | "auto"
  lang: "da", // html lang code. Set this empty and default will be "en"
  timezone: "Asia/Bangkok", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
