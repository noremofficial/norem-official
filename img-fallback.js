// Add data-img-collapse to any background-image element.
// If its image is missing or fails to load, the element (or its closest ancestor
// matching the attribute's value as a CSS selector) is hidden with display:none.
// Example: data-img-collapse          → hides the element itself
//          data-img-collapse=".card"  → hides the closest .card ancestor
function initImgCollapse() {
  document.querySelectorAll('[data-img-collapse]').forEach(function(el) {
    var sel = el.getAttribute('data-img-collapse') || '';
    function collapse() {
      var target = sel ? el.closest(sel) : el;
      if (target) target.style.display = 'none';
    }
    var src = el.style.backgroundImage;
    if (!src || src === 'none' || src === '') { collapse(); return; }
    var m = src.match(/url\(["']?([^"'()]+)["']?\)/);
    if (!m) { collapse(); return; }
    var img = new Image();
    img.onerror = collapse;
    img.src = m[1];
  });
}
window.initImgCollapse = initImgCollapse;
