export function mountNavigation(container, currentPage) {
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'ProtoFlow modular';
  const links = document.createElement('div');
  links.className = 'links';
  for (const [page, label] of [['chat', 'Chat'], ['settings', 'Settings']]) {
    const link = document.createElement('a');
    link.href = `${page}.html`;
    link.textContent = label;
    if (page === currentPage) link.setAttribute('aria-current', 'page');
    links.append(link);
  }
  container.replaceChildren(brand, links);
}
