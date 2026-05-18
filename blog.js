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

function updateSeoForDetail(blog) {
  const title = `${blog.title} Movie Review & Story | ZyroMovies Blog`;
  const description = blog.description || blog.overview || `${blog.title} blog`;
  const image = blog.bannerUrl || blog.posterUrl || "https://zyromovie.onrender.com/img/1.jpeg";
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
    card.innerHTML = `
      <img class="blog-card-image" src="${blog.bannerUrl || blog.posterUrl || "img/1.jpeg"}" alt="${blog.title || "Blog"}" />
      <div class="blog-card-body">
        <h2 class="blog-card-title">${blog.title || "Untitled"}</h2>
        <p class="blog-card-text">${(blog.description || blog.overview || "").slice(0, 180)}</p>
      </div>
    `;
    listEl.appendChild(card);
  });
}

function renderBlogDetail(blog) {
  const listView = document.getElementById("blog-list-view");
  const detailView = document.getElementById("blog-detail-view");
  const titleEl = document.getElementById("blog-detail-title");
  const bannerEl = document.getElementById("blog-detail-banner");
  const descEl = document.getElementById("blog-detail-description");
  if (!listView || !detailView || !titleEl || !bannerEl || !descEl) return;

  listView.style.display = "none";
  detailView.style.display = "block";

  titleEl.textContent = blog.title || "Untitled";
  bannerEl.src = blog.bannerUrl || blog.posterUrl || "img/1.jpeg";
  bannerEl.alt = blog.title || "Blog image";
  descEl.textContent = blog.description || blog.overview || "No description available.";

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
