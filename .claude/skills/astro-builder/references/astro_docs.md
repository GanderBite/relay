# Astro Documentation Reference

This file contains key Astro documentation for reference when building Astro websites.

## Table of Contents
1. [Core Concepts](#core-concepts)
2. [Project Structure](#project-structure)
3. [Component Syntax](#component-syntax)
4. [Routing](#routing)
5. [Styling](#styling)
6. [Images and Assets](#images-and-assets)
7. [Configuration](#configuration)

## Core Concepts

### Islands Architecture
Astro uses an islands architecture that renders HTML on the server and only hydrates interactive components on the client. This results in faster page loads with minimal JavaScript.

**Key Points:**
- Components are static by default
- Use `client:*` directives for interactivity
- Available directives: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`

### Zero JS by Default
Astro components render to static HTML. To add interactivity, use framework components with client directives.

## Project Structure

```
project/
├── src/
│   ├── components/    # Reusable Astro/framework components
│   ├── layouts/       # Page layouts
│   ├── pages/         # File-based routing (REQUIRED)
│   ├── styles/        # CSS/Sass files
│   ├── content/       # Content collections (optional)
│   └── assets/        # Optimized images
├── public/            # Static assets (copied as-is)
├── astro.config.mjs   # Astro configuration
├── package.json       # Dependencies
└── tsconfig.json      # TypeScript config
```

**Important:**
- `src/pages/` is REQUIRED - this is where routes are created
- `public/` files are served at root without processing
- Files in `src/` are processed and optimized

## Component Syntax

### Basic Component Structure
```astro
---
// Component Script (runs at build time)
import MyComponent from '../components/MyComponent.astro';
const greeting = "Hello";
---

<!-- Component Template -->
<div>
  <h1>{greeting}</h1>
  <MyComponent />
</div>

<style>
  h1 { color: blue; }
</style>
```

### Props
```astro
---
interface Props {
  title: string;
  description?: string;
}
const { title, description = "Default" } = Astro.props;
---
<h1>{title}</h1>
<p>{description}</p>
```

### Slots
```astro
<!-- Layout component -->
<div class="layout">
  <header>
    <slot name="header" />
  </header>
  <main>
    <slot /> <!-- Default slot -->
  </main>
</div>
```

## Routing

### File-Based Routing
- `src/pages/index.astro` → `/`
- `src/pages/about.astro` → `/about`
- `src/pages/blog/post-1.astro` → `/blog/post-1`

### Dynamic Routes
```astro
// src/pages/blog/[slug].astro
---
export async function getStaticPaths() {
  return [
    { params: { slug: 'post-1' } },
    { params: { slug: 'post-2' } },
  ];
}
const { slug } = Astro.params;
---
```

## Styling

### Scoped Styles
```astro
<style>
  /* Automatically scoped to this component */
  h1 { color: blue; }
</style>
```

### Global Styles
```astro
<style is:global>
  /* Applies globally */
  body { margin: 0; }
</style>
```

### Tailwind CSS
1. Install: `npx astro add tailwind`
2. Use classes directly in templates

## Images and Assets

### Using the Image Component
```astro
---
import { Image } from 'astro:assets';
import myImage from '../assets/image.png';
---

<Image src={myImage} alt="Description" width={600} height={400} />
```

### Public Assets
Place in `public/` folder and reference directly:
```html
<img src="/logo.png" alt="Logo" />
```

## Configuration

### Basic astro.config.mjs
```js
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://example.com',
  base: '/docs',
  integrations: [],
  vite: {
    // Vite config
  }
});
```

### Adding Integrations
```bash
# Using CLI (recommended)
npx astro add react
npx astro add tailwind

# Manual installation
npm install @astrojs/react
```

## Content Collections

### Define Collections
```ts
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
  }),
});

export const collections = { blog };
```

### Query Collections
```astro
---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
```

## Framework Components

### React Integration
```astro
---
import ReactComponent from '../components/ReactComponent.jsx';
---

<!-- Static by default -->
<ReactComponent />

<!-- Interactive with hydration -->
<ReactComponent client:load />
```

## Best Practices

1. **Keep Components Static**: Only add `client:*` directives when necessary
2. **Use Layouts**: Create reusable layouts for consistent page structure
3. **Optimize Images**: Use the `Image` component for automatic optimization
4. **Type Safety**: Use TypeScript for props and better DX
5. **Content Collections**: Use for type-safe content management
6. **Code Splitting**: Astro automatically code-splits by page

## Common Patterns

### SEO Meta Tags
```astro
---
const { title, description } = Astro.props;
---

<head>
  <meta charset="UTF-8" />
  <meta name="description" content={description} />
  <meta name="viewport" content="width=device-width" />
  <title>{title}</title>
</head>
```

### API Routes
```ts
// src/pages/api/hello.ts
export async function GET() {
  return new Response(JSON.stringify({
    message: "Hello"
  }));
}
```

### Markdown/MDX Pages
```md
---
layout: ../../layouts/BlogPost.astro
title: My Post
---

# Content goes here
```
