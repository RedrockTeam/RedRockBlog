---
title: RedRockBlog
type: landing
sections:
  - block: hero
    content:
      title: "RedRockBlog"
      text: |
        The technical blog of the RedRock team. Multi-author, component-based,
        written in pure Markdown.
      primary_action:
        text: "View Blog"
        url: "/blog"
        icon: "hero/arrow-right"
      secondary_action:
        text: "Authors"
        url: "/authors"
    design:
      css_class: "hero-gradient"
      background:
        gradient:
          start: "primary-600"
          end: "primary-400"
          direction: "135"

  - block: features
    content:
      title: "Site Features"
      items:
        - name: "Multi-author"
          description: "Every author has a profile page, with posts aggregated automatically"
          icon: "hero/users"
        - name: "Component-based"
          description: "Pages are assembled from blocks; add sections without touching templates"
          icon: "hero/squares-2x2"
        - name: "GitHub workflow"
          description: "Contributors only submit article markdown; author profiles are generated automatically"
          icon: "hero/rocket-launch"
    design:
      columns: 3

  - block: collection
    content:
      title: "Latest Posts"
      count: 5
      filters:
        folders:
          - blog
    design:
      view: article-grid
      columns: 2
---

RedRockBlog homepage. Page sections are configured via the `sections` front matter.
