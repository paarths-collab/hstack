# Animation references

The homepage ASCII artwork is the selected [21st.dev network artwork](https://21st.dev/community/ascii/image-3267549b-67c8-4dbf-992c-eda61a71a63e). Its reference is recorded here; the visible artwork credit was removed from the hero.

The following public 21st.dev demos inform the website's motion:

- [Masonry Grid with Scroll Animation — Ravi Katiyar](https://21st.dev/@ravikatiyar162/components/masonry-grid-with-scroll-animation): responsive masonry cards with a slide-and-rotate entrance. Its slide-and-rotate entrance is used by homepage feature cards, now arranged in a pinned, vertically driven horizontal track. The reusable MasonryGrid helper remains available for masonry layouts.
- [Reveal — asanshay](https://21st.dev/@asanshay/components/reveal): staggered fade-and-unblur entrances. Applied to homepage introductions, install cards, and docs overview cards.
- [Scroll Reveal — Mohammad Shehadeh](https://21st.dev/@mohammadshehadeh/components/scroll-reveal): viewport-triggered fade-and-slide entrances. Applied to section headings and integration cards.
- [Footer reveal — Motion](https://21st.dev/@motiondotdev/components/motion-footer-reveal): fade, scale, and unblur. Applied to the homepage footer.

The four reveal/masonry effects above are original HSTACK implementations based on public descriptions and demo usage; their source downloads require 21st.dev account access. The horizontal section additionally references UI Layouts’ official public source, linked below. The adaptations use the browser's Web Animations API, IntersectionObserver, and native scroll updates with the existing plain CSS setup.

All content is visible before hydration and with JavaScript disabled. Entrances play once per mounted component. Reduced-motion preferences disable entrances, including when the preference changes during an animation. Keyboard focus cancels any entrance on the focused content. The Features section pins below the header and maps native vertical scroll progress to the horizontal position of full-width feature panels. It releases after the last panel and reverses when scrolling upward. Previous/next buttons and Arrow/Home/End keys also move through the section. Reduced-motion preferences, JavaScript-disabled browsers, and viewports too short for a readable panel retain a native horizontal track without a long pinned section. Reading pages use only gentle header/card entrances; paragraphs remain static.

Page scrolling uses the browser's native wheel, touch, and keyboard behavior. The Features section adds its own pinned scroll range, without page-wide smoothing, inertia overrides, or wheel interception.

## Pinned horizontal reference

The behavior follows [Horizontal Scroll by UI Layouts on 21st.dev](https://21st.dev/@uilayout.contact/components/horizontal-scroll). Its [official public source](https://github.com/ui-layouts/uilayouts/blob/main/apps/ui-layout/registry/components/external/horizontal-scroll.txt) uses a tall section and sticky horizontal panels. That source is published under the repository’s [MIT license](https://github.com/ui-layouts/uilayouts/blob/main/LICENSE), Copyright (c) 2024 UI LAYOUT. HSTACK implements the pattern with scoped native scroll updates and responsive content measurements; the reference’s global Lenis wrapper is not used.
