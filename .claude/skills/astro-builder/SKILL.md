---
name: astro-builder
description: Comprehensive skill for building websites with Astro.build. Use when the user wants to create a website using Astro, needs to select an appropriate theme from Astro's free themes collection, requires access to Astro documentation, or wants to develop Astro components and pages. This skill handles theme selection, documentation access, project setup, and Astro-specific development patterns.
---

# Astro Website Builder

This skill helps you build websites with Astro.build by guiding you through theme selection, documentation access, and development best practices. Use this skill whenever a user mentions building with Astro, wants to create a website, or needs help with Astro-specific features.

## When to Use This Skill

Activate this skill when:
- User mentions "Astro" or "astro.build" in their request
- User wants to build a website and Astro would be appropriate (blogs, documentation, portfolios, marketing sites, etc.)
- User needs to select a theme for their Astro project
- User needs help with Astro components, routing, or configuration
- User wants to integrate React, Vue, or other frameworks with Astro
- User needs access to Astro's documentation or best practices

## Workflow Overview

When building an Astro website, follow this process:

1. **Understand Requirements** - Determine the type of website and features needed
2. **Select Appropriate Theme** - Choose from Astro's free themes based on requirements
3. **Access Documentation** - Reference Astro docs for specific features
4. **Initialize Project** - Set up the project structure
5. **Develop Components** - Build using Astro's component architecture
6. **Optimize & Deploy** - Follow best practices for performance

## Step 1: Understand Requirements

First, identify the type of website and its requirements:

**Website Types:**
- Blog/Publication site
- Portfolio/Showcase
- Documentation site
- Marketing/Landing page
- E-commerce site
- Company/Business site
- Personal website

**Key Questions to Ask:**
- What is the primary purpose of the site?
- What content types will it have? (blog posts, projects, products, etc.)
- Does it need interactivity? (forms, search, dynamic content)
- What frameworks does the user prefer? (React, Vue, Svelte, etc.)
- Does it need specific features? (dark mode, i18n, CMS integration)

## Step 2: Select Appropriate Theme

Use web_fetch to browse free React-compatible themes:

```
URL: https://astro.build/themes/1/?search=&technology%5B%5D=react&price%5B%5D=free
```

**Theme Selection Criteria:**

For **Blogs/Publications**:
- Look for themes with strong typography
- Must support Markdown/MDX
- Should have tags/categories
- RSS feed support
- Consider: astro-paper, astro-blog-template

For **Portfolios**:
- Visual project showcase
- About/Contact sections
- Smooth animations
- Consider: astro-portfolio, personal-portfolio themes

For **Documentation**:
- Use Starlight (official Astro docs framework)
- Features: Search, sidebar navigation, dark mode, i18n
- Best for: Technical docs, API references, guides

For **Landing Pages**:
- Hero section with CTA
- Features/Benefits sections
- Contact forms
- Conversion-optimized

For **E-commerce**:
- Product listings and filters
- Shopping cart functionality
- Payment integration ready
- Product detail pages

**Action:** Fetch the themes page, analyze available themes, and recommend 2-3 options that best match the user's requirements. Explain why each theme is suitable.

## Step 3: Access Astro Documentation

When you need specific Astro documentation, reference:

1. **Built-in Reference**: `references/astro_docs.md` - Contains core Astro concepts, syntax, and common patterns
2. **Full Documentation**: Fetch from `https://docs.astro.build/llms-full.txt` for comprehensive information

**When to Reference Documentation:**
- Component syntax questions → Reference astro_docs.md
- Routing and pages → Reference astro_docs.md  
- Styling options → Reference astro_docs.md
- Advanced features → Fetch from docs.astro.build
- Integration setup → Fetch from docs.astro.build
- API details → Fetch from docs.astro.build

## Step 4: Initialize Astro Project

### Using Create Astro CLI

```bash
# Create new project
npm create astro@latest

# Or with specific template
npm create astro@latest -- --template <theme-github-username>/<theme-repo>
```

### Project Structure Setup

After initialization, ensure proper structure:

```
project/
├── src/
│   ├── components/     # Reusable components
│   ├── layouts/        # Page layouts
│   ├── pages/          # Routes (REQUIRED)
│   │   └── index.astro # Homepage
│   ├── content/        # Content collections (optional)
│   └── assets/         # Optimized images
├── public/             # Static assets
├── astro.config.mjs    # Configuration
├── package.json
└── tsconfig.json
```

**Critical:** The `src/pages/` directory is REQUIRED for routing to work.

## Step 5: Develop Components and Pages

### Component Development Pattern

1. **Create component file** in `src/components/`
2. **Define props interface** (if using TypeScript)
3. **Write component script** (runs at build time)
4. **Create template** (HTML with Astro syntax)
5. **Add scoped styles** (optional)

Example:
```astro
---
interface Props {
  title: string;
  description?: string;
}
const { title, description } = Astro.props;
---

<article>
  <h2>{title}</h2>
  {description && <p>{description}</p>}
</article>

<style>
  article {
    padding: 1rem;
    border: 1px solid #ccc;
  }
</style>
```

### Page Development Pattern

1. **Create page file** in `src/pages/` (determines route)
2. **Import necessary components and layouts**
3. **Define getStaticPaths()** for dynamic routes
4. **Compose page using components**

Example page:
```astro
---
import Layout from '../layouts/Layout.astro';
import Hero from '../components/Hero.astro';

const title = "My Page";
---

<Layout title={title}>
  <Hero />
  <!-- More content -->
</Layout>
```

### Adding Interactivity

When you need client-side interactivity:

1. **Install framework integration**: `npx astro add react`
2. **Create framework component** (.jsx, .vue, .svelte)
3. **Import and use with client directive**:

```astro
---
import ReactComponent from '../components/ReactComponent.jsx';
---

<!-- Static (no JS) -->
<ReactComponent />

<!-- Interactive -->
<ReactComponent client:load />
<!-- Options: client:idle, client:visible, client:media -->
```

## Step 6: Reference Documentation as Needed

**Before writing code**, read the relevant sections from `references/astro_docs.md`:

- **Component questions** → Read "Component Syntax" section
- **Routing issues** → Read "Routing" section
- **Styling** → Read "Styling" section
- **Images** → Read "Images and Assets" section
- **Configuration** → Read "Configuration" section

**For advanced topics**, fetch full documentation:
```
web_fetch: https://docs.astro.build/llms-full.txt
```

## Best Practices

### Performance Optimization

1. **Keep components static by default** - Only add `client:*` when truly needed
2. **Use Astro's Image component** - Automatic optimization
3. **Leverage islands architecture** - Minimal JavaScript by default
4. **Code splitting** - Astro automatically splits by page

### Development Workflow

1. **Start with structure** - Set up layouts and basic pages first
2. **Component-driven** - Build reusable components
3. **Type safety** - Use TypeScript for props and better DX
4. **Content Collections** - For type-safe content management
5. **Test locally** - Run `npm run dev` frequently

### Common Patterns to Follow

- Use layouts for consistent page structure
- Create SEO component for meta tags
- Set up proper TypeScript interfaces
- Implement proper error pages (404, 500)
- Add proper alt text to images
- Use semantic HTML

## Troubleshooting

### Common Issues

**"Module not found"**
- Ensure correct import paths
- Check that integrations are installed
- Verify `astro.config.mjs` has correct integration setup

**"Page not rendering"**
- Verify file is in `src/pages/` directory
- Check for syntax errors in frontmatter
- Ensure proper file extension (.astro, .md, .mdx)

**"Styles not applying"**
- Scoped styles only apply to component's own HTML
- Use `is:global` for global styles
- Check Tailwind configuration if using Tailwind

**"Component not interactive"**
- Add `client:*` directive to framework components
- Ensure integration is installed (e.g., `@astrojs/react`)
- Check browser console for JavaScript errors

## Resources

### Scripts

- `scripts/theme_analyzer.py` - Helps fetch and analyze Astro themes from the official themes page. Use this to programmatically explore theme options based on technology and price filters.

### References  

- `references/astro_docs.md` - **READ THIS FIRST** for core Astro concepts, component syntax, routing, styling, and common patterns. This is your primary reference for Astro development.

### External Resources

- **Astro Themes**: https://astro.build/themes/
- **Astro Docs (LLM-friendly)**: https://docs.astro.build/llms-full.txt
- **Astro Documentation**: https://docs.astro.build
- **Astro Discord**: https://astro.build/chat

## Example Workflows

### Example 1: Building a Blog

User: "I want to build a blog with Astro and React"

**Workflow:**
1. Identify requirements: Blog site, needs React support, wants free theme
2. Fetch themes: `web_fetch https://astro.build/themes/1/?technology%5B%5D=react&price%5B%5D=free`
3. Recommend theme: Suggest 2-3 blog-oriented themes with explanations
4. Read `references/astro_docs.md` to reference component patterns
5. Guide setup: Provide installation commands and structure
6. Help build: Create blog post layout, listing page, individual post pages
7. Add interactivity: Show how to add React components with `client:load` for features like comments

### Example 2: Portfolio Website

User: "Create a portfolio site for me using https://astro.build/"

**Workflow:**
1. Clarify requirements: What to showcase (projects, skills, experience?)
2. Fetch portfolio themes from Astro themes page
3. Recommend best match based on user's field (developer, designer, etc.)
4. Read component syntax from `references/astro_docs.md`
5. Set up project structure with selected theme
6. Create/customize components (Hero, Projects grid, About, Contact)
7. Add smooth transitions if needed
8. Optimize images using Astro's Image component

### Example 3: Documentation Site

User: "I need documentation site with search and dark mode"

**Workflow:**
1. Identify: Documentation site, needs search and dark mode
2. **Recommend Starlight** (official Astro docs framework)
3. Show setup: `npm create astro@latest -- --template starlight`
4. Reference Starlight docs from full Astro documentation
5. Configure sidebar navigation structure
6. Set up content structure
7. Enable dark mode (built-in)
8. Configure search (built-in with Pagefind)

## Key Reminders

1. **Always read `references/astro_docs.md` FIRST** before answering component or syntax questions
2. **Fetch themes** from the Astro themes page when user needs a starting point
3. **Use web_fetch** for full documentation when needed
4. **Keep it simple** - Astro is designed to be straightforward; don't over-complicate
5. **Islands architecture** - Remember that components are static by default
6. **Type safety** - Encourage TypeScript usage for better development experience

## Success Criteria

An Astro project is set up correctly when:
- ✅ Project structure follows Astro conventions
- ✅ `src/pages/` directory exists with at least index.astro
- ✅ Appropriate theme selected based on requirements
- ✅ Components follow Astro syntax patterns
- ✅ Client-side interactivity only added where needed
- ✅ TypeScript interfaces defined for component props
- ✅ Images optimized using Astro's Image component
- ✅ Site runs successfully with `npm run dev`
