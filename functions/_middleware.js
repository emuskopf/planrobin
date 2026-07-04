// Runs on every request to the Pages project. Canonical host: 301 www.planrobin.com ->
// planrobin.com (path + query preserved). All other hosts (apex, *.pages.dev) pass through.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === 'www.planrobin.com') {
    url.hostname = 'planrobin.com';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
