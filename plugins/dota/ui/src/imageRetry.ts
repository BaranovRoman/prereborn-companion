// A WebView can keep a failed response for a Steam CDN image (seen for the
// same few heroes on every launch). Retry each failed CDN image once with a
// cache-busting query on the same allowed host; never a different origin.
const CDN = "https://cdn.cloudflare.steamstatic.com/";
export function retryFailedCdnImages(root: Document = document) {
  root.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.src.startsWith(CDN) || image.dataset.cdnRetry) return;
    image.dataset.cdnRetry = "1";
    const url = new URL(image.src); url.searchParams.set("r", "1");
    image.src = url.toString();
  }, true);
}
