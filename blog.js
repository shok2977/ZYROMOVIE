const API_BASE =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3001"
    : "";

async function fetchBlogs() {
  const res = await fetch(`${API_BASE}/api/blogs`);
  if (!res.ok) throw new Error("Failed to fetch blogs");
  return await res.json();
}

async function fetchBlogBySlug(slug) {
  const res = await fetch(`${API_BASE}/api/blog/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error("Blog not found");
  return await res.json();
}

function getBlogExcerpt(blog) {
  if (blog?.description) return blog.description;
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    if (section?.textBefore) return section.textBefore;
    if (section?.textAfter) return section.textAfter;
  }
  return blog?.overview || "";
}

function normalizeImageKind(kind) {
  return String(kind || "").toLowerCase() === "banner" ? "banner" : "photo";
}

function resolveBlogImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (
    value.startsWith("data:") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }
  if (value.startsWith("/")) {
    return `${API_BASE}${value}`;
  }
  return value;
}

function getBlogSeoImage(blog) {
  const sections = Array.isArray(blog?.sections) ? blog.sections : [];
  for (const section of sections) {
    if (section?.imageDataUrl) return section.imageDataUrl;
  }
  return blog.bannerUrl || blog.posterUrl || "https://zyromovie.onrender.com/img/1.jpeg";
}

function updateSeoForDetail(blog) {
  const title = `${blog.title} Movie Review & Story | ZyroMovies Blog`;
  const description = getBlogExcerpt(blog) || `${blog.title} blog`;
  const image = getBlogSeoImage(blog);
  const canonical = `${window.location.origin}/blog/${encodeURIComponent(blog.slug)}`;

  document.title = title;

  const upsertMeta = (selector, attr, value) => {
    let el = document.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      if (selector.includes("property=")) {
        const prop = selector.match(/property="([^"]+)"/)?.[1];
        if (prop) el.setAttribute("property", prop);
      } else {
        const name = selector.match(/name="([^"]+)"/)?.[1];
        if (name) el.setAttribute("name", name);
      }
      document.head.appendChild(el);
    }
    el.setAttribute(attr, value);
  };

  upsertMeta('meta[name="description"]', "content", description);
  upsertMeta('meta[property="og:title"]', "content", title);
  upsertMeta('meta[property="og:description"]', "content", description);
  upsertMeta('meta[property="og:image"]', "content", image);
  upsertMeta('meta[property="og:url"]', "content", canonical);
  upsertMeta('meta[name="twitter:title"]', "content", title);
  upsertMeta('meta[name="twitter:description"]', "content", description);
  upsertMeta('meta[name="twitter:image"]', "content", image);

  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = canonical;
}

function renderBlogList(blogs) {
  const listEl = document.getElementById("blog-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!blogs.length) {
    listEl.innerHTML = '<p class="admin-empty">No blogs yet.</p>';
    return;
  }

  blogs.forEach((blog) => {
    const card = document.createElement("a");
    card.className = "blog-card";
    card.href = `blog.html?slug=${encodeURIComponent(blog.slug)}`;
    const excerpt = getBlogExcerpt(blog).slice(0, 180);
    card.innerHTML = `
      <img class="blog-card-image" src="${blog.bannerUrl || blog.posterUrl || "img/1.jpeg"}" alt="${blog.title || "Blog"}" />
      <div class="blog-card-body">
        <h2 class="blog-card-title">${blog.title || "Untitled"}</h2>
        <p class="blog-card-text">${excerpt}</p>
      </div>
    `;
    listEl.appendChild(card);
  });
}

function renderBlogSections(blog) {
  const sectionsEl = document.getElementById("blog-detail-sections");
  if (!sectionsEl) return;
  sectionsEl.innerHTML = "";

  const sections = Array.isArray(blog.sections) ? blog.sections : [];
  if (!sections.length) return;

  sections.forEach((section, index) => {
    const textBefore = String(section?.textBefore || "").trim();
    const textAfter = String(section?.textAfter || "").trim();
    const imageSrc = resolveBlogImageUrl(
      section?.imageDataUrl || section?.imageUrl || ""
    );

    if (!textBefore && !textAfter && !imageSrc) return;

    const block = document.createElement("section");
    block.className = "blog-content-block";

    const heading = document.createElement("h2");
    heading.className = "blog-block-label";
    heading.textContent = `Section ${index + 1}`;
    block.appendChild(heading);

    if (textBefore) {
      const beforeWrap = document.createElement("div");
      beforeWrap.className = "blog-text-block";
      const beforeLabel = document.createElement("span");
      beforeLabel.className = "blog-text-block-label";
      beforeLabel.textContent = "Text before image";
      const before = document.createElement("p");
      before.className = "blog-detail-text";
      before.textContent = textBefore;
      beforeWrap.appendChild(beforeLabel);
      beforeWrap.appendChild(before);
      block.appendChild(beforeWrap);
    }

    if (imageSrc) {
      const kind = normalizeImageKind(section.imageKind);
      const figure = document.createElement("figure");
      figure.className = `blog-figure blog-figure--${kind}`;
      const img = document.createElement("img");
      img.src = imageSrc;
      img.alt = `${blog.title || "Blog"} - ${kind}`;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      figure.appendChild(img);
      block.appendChild(figure);
    }

    if (textAfter) {
      const afterWrap = document.createElement("div");
      afterWrap.className = "blog-text-block";
      const afterLabel = document.createElement("span");
      afterLabel.className = "blog-text-block-label";
      afterLabel.textContent = "Text after image";
      const after = document.createElement("p");
      after.className = "blog-detail-text";
      after.textContent = textAfter;
      afterWrap.appendChild(afterLabel);
      afterWrap.appendChild(after);
      block.appendChild(afterWrap);
    }

    sectionsEl.appendChild(block);
  });
}

function renderBlogDetail(blog) {
  const listView = document.getElementById("blog-list-view");
  const detailView = document.getElementById("blog-detail-view");
  const titleEl = document.getElementById("blog-detail-title");
  const introWrap = document.getElementById("blog-detail-intro-wrap");
  const descEl = document.getElementById("blog-detail-description");
  if (!listView || !detailView || !titleEl || !descEl) return;

  listView.style.display = "none";
  detailView.style.display = "block";

  titleEl.textContent = blog.title || "Untitled";

  const intro = blog.description || "";
  descEl.textContent = intro;
  if (introWrap) introWrap.style.display = intro ? "block" : "none";

  renderBlogSections(blog);
  updateSeoForDetail(blog);
}

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug");

  try {
    if (slug) {
      const blog = await fetchBlogBySlug(slug);
      renderBlogDetail(blog);
      return;
    }
    const blogs = await fetchBlogs();
    renderBlogList(blogs);
  } catch (error) {
    const listEl = document.getElementById("blog-list");
    if (listEl) listEl.innerHTML = '<p class="admin-empty">Failed to load blogs.</p>';
    console.error(error);
  }
});
