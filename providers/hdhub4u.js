// HDhub4u Scraper for Nuvio
// Movies & TV Series — Hindi / English / Multi
// Ported from: github.com/phisher98/cloudstream-extensions-phisher/HDhub4u
// NO async/await — only .then() chains

var TMDB_KEY    = 'd80ba92bc7cefe3359668d30d06f3305'
var DOMAINS_URL = 'https://raw.githubusercontent.com/AbhishekVankar/TV/refs/heads/main/domains.json'
var SEARCH_URL  = 'https://search.pingora.fyi/collections/post/documents/search'
var UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
var COOKIE      = 'xla=s4t'

var BASE_HEADERS = {
  'User-Agent'     : UA,
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection'     : 'close',
  'Upgrade-Insecure-Requests': '1'
}

var domainCache = { url: 'https://hdhub4u.rehab', ts: 0 }

// ── WebCrypto shim for Node.js testing ───────────────────────────────────────
var _crypto = (typeof crypto !== 'undefined' && crypto.subtle)
  ? crypto
  : (function() { try { return require('crypto').webcrypto } catch(e) { return null } })()

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url, headers) {
  return fetch(url, {
    headers: Object.assign({}, BASE_HEADERS, headers || {})
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' → ' + url)
    return r.text()
  })
}

function httpGetJson(url, headers) {
  return fetch(url, {
    headers: Object.assign({}, BASE_HEADERS, headers || {})
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' → ' + url)
    return r.json()
  })
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function b64decode(input) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  var str = String(input).replace(/=+$/, '')
  if (str.length % 4 === 1) return ''
  var output = ''
  for (var bc = 0, bs, buffer, i = 0;
    buffer = str.charAt(i++);
    ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4)
      ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer)
  }
  return output
}

// ROT-13 — used in redirect decode chain (CS: pen())
function rot13(str) {
  return str.replace(/[a-zA-Z]/g, function(c) {
    var base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

function extractQuality(text) {
  var t = (text || '').toUpperCase()
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '4K'
  if (/\b1080P\b/.test(t))          return '1080p'
  if (/\b720P\b/.test(t))           return '720p'
  if (/\b480P\b/.test(t))           return '480p'
  return 'HD'
}

function getOrigin(url) {
  var m = (url || '').match(/^(https?:\/\/[^\/]+)/)
  return m ? m[1] : ''
}

function hexToUint8(hex) {
  var arr = new Uint8Array(hex.length / 2)
  for (var i = 0; i < hex.length; i += 2)
    arr[i / 2] = parseInt(hex.substr(i, 2), 16)
  return arr
}

function strToUint8(str) {
  var arr = new Uint8Array(str.length)
  for (var i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff
  return arr
}

// ── Domain fetching ───────────────────────────────────────────────────────────
// CS ref: HDhub4uPlugin.getDomains() — fetches domains.json, caches 1 hr

function fetchDomain() {
  var now = Date.now()
  if (now - domainCache.ts < 36e5) return Promise.resolve(domainCache.url)
  return httpGetJson(DOMAINS_URL)
    .then(function(data) {
      if (data && data['HDHUB4u']) {
        domainCache.url = data['HDHUB4u']
        domainCache.ts  = now
        console.log('[HDhub4u] Domain: ' + domainCache.url)
      }
      return domainCache.url
    })
    .catch(function() { return domainCache.url })
}

// ── TMDB ──────────────────────────────────────────────────────────────────────

function getTmdbDetails(tmdbId, type) {
  var isTv = type === 'tv' || type === 'series'
  var endpoint = isTv ? 'tv' : 'movie'
  return fetch('https://api.themoviedb.org/3/' + endpoint + '/' + tmdbId + '?api_key=' + TMDB_KEY)
    .then(function(r) { return r.json() })
    .then(function(d) {
      return {
        title: d.title || d.name || '',
        year:  parseInt((d.release_date || d.first_air_date || '0000').split('-')[0])
      }
    })
}

// ── Search ────────────────────────────────────────────────────────────────────
// CS ref: search() — uses Typesense index at search.pingora.fyi
// Returns hits[].document with { permalink, post_title, post_thumbnail, category[] }

function searchSite(title, isTv, domain) {
  var url = SEARCH_URL
    + '?q='              + encodeURIComponent(title)
    + '&query_by=post_title,category&query_by_weights=4,2'
    + '&sort_by=sort_by_date:desc&limit=20&highlight_fields=none&use_cache=true&page=1'

  console.log('[HDhub4u] Search: ' + title)
  return httpGetJson(url, { 'Referer': domain + '/' })
    .then(function(data) {
      if (!data || !data.hits) return []
      var results = data.hits.map(function(h) {
        var permalink = h.document.permalink || ''
        // Typesense returns relative paths like /slug/ — make them absolute
        if (permalink.indexOf('http') !== 0) permalink = domain + permalink
        return {
          url   : permalink,
          title : h.document.post_title,
          poster: h.document.post_thumbnail,
          cats  : (h.document.category || []).join(' ').toLowerCase()
        }
      })

      // Type filter based on category tags
      var typed = results.filter(function(r) {
        if (isTv) return /series|web.series|episode/.test(r.cats)
        return /movie|bollywood|hollywood|dubbed/.test(r.cats)
      })
      var candidates = typed.length > 0 ? typed : results
      console.log('[HDhub4u] Results: ' + candidates.length)
      if (candidates.length > 0)
        console.log('[HDhub4u] Best: "' + candidates[0].title + '" → ' + candidates[0].url)
      return candidates
    })
}

// ── Redirect link decoder ─────────────────────────────────────────────────────
// CS ref: getRedirectLinks() in Utils.kt
//
// The redirect page contains JS with encoded data in two possible patterns:
//   s('o','<base64>')             ← pattern 1
//   ck('_wp_http_N','<base64>')   ← pattern 2
//
// Decode chain:  base64 → base64 → ROT13 → base64 → JSON
// Final URL: base64Decode(json.o)  OR  fetch(json.blog_url + '?re=' + base64Decode(json.data))

function getRedirectLinks(url) {
  if (!url || url.length < 5) return Promise.resolve('')
  return httpGet(url, { 'Referer': url, 'Cookie': COOKIE })
    .then(function(text) {
      var combined = ''
      var m
      var re1 = /s\('o','([A-Za-z0-9+\/=]+)'/g
      var re2 = /ck\('_wp_http_\d+','([^']+)'/g
      while ((m = re1.exec(text)) !== null) combined += m[1]
      while ((m = re2.exec(text)) !== null) combined += m[1]

      if (!combined) {
        console.log('[HDhub4u] No encoded payload in redirect page: ' + url)
        return url
      }

      try {
        // 4-step decode (Utils.kt): base64Decode(pen(base64Decode(base64Decode(combined))))
        var decoded = b64decode(rot13(b64decode(b64decode(combined))))
        var json    = JSON.parse(decoded)

        if (json.o) {
          var finalUrl = b64decode(json.o).trim()
          console.log('[HDhub4u] Redirect → ' + finalUrl)
          return finalUrl
        }

        if (json.blog_url && json.data) {
          var reParam = b64decode(json.data).trim()
          return httpGet(json.blog_url + '?re=' + reParam)
            .then(function(body) {
              var r = body.trim()
              console.log('[HDhub4u] Redirect (blog) → ' + r)
              return r
            })
        }
      } catch(e) {
        console.log('[HDhub4u] Redirect decode error: ' + e.message)
      }
      return ''
    })
    .catch(function(e) {
      console.log('[HDhub4u] Redirect fetch error: ' + e.message)
      return ''
    })
}

// ── HubCloud extractor ────────────────────────────────────────────────────────
// CS ref: HubCloud.getUrl() in Extractors.kt
//
// Flow:
//   1. If URL is not a hubcloud.php URL → fetch page → get #download href
//   2. GET the download page → parse <a class="btn"> buttons
//   3. Each button label determines the source (FSL, Direct, Pixeldrain, etc.)

function extractHubCloud(url) {
  var host = getOrigin(url)

  function resolveDownloadPage() {
    if (url.indexOf('hubcloud.php') !== -1) return Promise.resolve(url)
    return httpGet(url, { 'Referer': url })
      .then(function(html) {
        var m = html.match(/id="download"[^>]*href="([^"]+)"/)
               || html.match(/href="([^"]+)"[^>]*id="download"/)
        if (!m) return url
        var href = m[1]
        if (href.indexOf('http') !== 0) href = host + (href.charAt(0) === '/' ? '' : '/') + href
        return href
      })
  }

  return resolveDownloadPage()
    .then(function(dlUrl) {
      return httpGet(dlUrl, { 'Referer': url })
        .then(function(html) {
          // Quality from card header
          var headerMatch = html.match(/<div[^>]*class="[^"]*card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/)
          var quality = extractQuality(headerMatch ? headerMatch[1] : html)

          var directStreams = []
          var buzzJobs      = []
          var seen          = {}

          function parseBtn(href, rawLabel) {
            if (!href || seen[href]) return
            seen[href] = true
            var label = rawLabel.replace(/<[^>]+>/g, '').trim().toLowerCase()
            var source

            if      (/fsl\s*v?2/.test(label))                             source = 'FSLv2'
            else if (/fsl/.test(label))                                    source = 'FSL Server'
            else if (/download\s*file/.test(label))                        source = 'Direct Download'
            else if (/pixeldra|pixel\s*server|pixeldrain/.test(label))    source = 'Pixeldrain'
            else if (/buzz/.test(label))                                   source = 'BuzzServer'
            else if (/s3\s*server/.test(label))                            source = 'S3 Server'
            else if (/mega/.test(label))                                   source = 'Mega Server'
            else return

            // Pixeldrain: convert /u/ path to API download path
            if (source === 'Pixeldrain' && href.indexOf('/u/') !== -1) {
              var base = getOrigin(href)
              href = base + '/api/file/' + href.split('/u/').pop() + '?download'
            }

            // BuzzServer: must follow hx-redirect header (CS: allowRedirects=false)
            if (source === 'BuzzServer') {
              buzzJobs.push({ url: href, quality: quality })
            } else {
              directStreams.push({ url: href, quality: quality, source: source })
            }
          }

          var m
          // Match both attribute orderings of <a class="btn" href="...">
          var btnRe1 = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*btn[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
          var btnRe2 = /<a[^>]+class="[^"]*btn[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
          while ((m = btnRe1.exec(html)) !== null) parseBtn(m[1], m[2])
          while ((m = btnRe2.exec(html)) !== null) parseBtn(m[1], m[2])

          // Resolve BuzzServer redirects (hx-redirect header) in parallel
          return Promise.all(buzzJobs.map(function(j) {
            return resolveBuzzServer(j.url, j.quality)
          })).then(function(buzzResults) {
            var streams = directStreams.concat(
              buzzResults.reduce(function(acc, r) { return acc.concat(r) }, [])
            )
            console.log('[HDhub4u] HubCloud streams: ' + streams.length)
            return streams
          })
        })
    })
    .catch(function(e) {
      console.log('[HDhub4u] HubCloud error: ' + e.message)
      return []
    })
}

// ── HubDrive extractor ────────────────────────────────────────────────────────
// CS ref: Hubdrive.getUrl() — clicks the primary button → HubCloud or loadExtractor

function extractHubDrive(url) {
  return httpGet(url, { 'Referer': url })
    .then(function(html) {
      var m = html.match(/class="btn btn-primary btn-user btn-success1[^"]*"[^>]*href="([^"]+)"/)
             || html.match(/href="([^"]+)"[^>]*class="btn btn-primary btn-user btn-success1/)
      if (!m) return []
      var href = m[1]
      if (/hubcloud/i.test(href)) return extractHubCloud(href)
      return extractByHost(href)
    })
    .catch(function() { return [] })
}

// ── VidStack / Hubstream extractor ────────────────────────────────────────────
// CS ref: VidStack.getUrl() in Extractors.kt
//
// GET /api/v1/video?id=HASH → encrypted hex string
// Decrypt AES-128-CBC with key "kiemtienmua911ca", try 2 IVs
// Parse JSON → "source" field = M3U8 URL

function extractVidStack(url) {
  if (!_crypto) {
    console.log('[HDhub4u] WebCrypto not available, skipping VidStack')
    return Promise.resolve([])
  }

  var host = getOrigin(url)
  var hash = url.indexOf('#') !== -1
    ? url.split('#').pop().replace(/^\//, '')
    : url.split('/').pop().split('?')[0]

  var AES_KEY = 'kiemtienmua911ca'
  var AES_IVS = ['1234567890oiuytr', '0123456789abcdef']

  return httpGet(host + '/api/v1/video?id=' + hash, { 'Referer': url })
    .then(function(encoded) {
      encoded = (encoded || '').trim()
      if (!encoded) return []

      var keyBytes  = strToUint8(AES_KEY)
      var dataBytes = hexToUint8(encoded)

      function tryIV(idx) {
        if (idx >= AES_IVS.length) return Promise.resolve(null)
        var ivBytes = strToUint8(AES_IVS[idx])
        return _crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'])
          .then(function(key) {
            return _crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, dataBytes)
          })
          .then(function(buf) {
            return new TextDecoder().decode(new Uint8Array(buf))
          })
          .catch(function() { return tryIV(idx + 1) })
      }

      return tryIV(0).then(function(decrypted) {
        if (!decrypted) return []
        var m3u8Match = decrypted.match(/"source"\s*:\s*"(.*?)"/)
        if (!m3u8Match) return []
        var m3u8 = m3u8Match[1].replace(/\\\//g, '/').replace(/^https/, 'http')
        console.log('[HDhub4u] VidStack stream: ' + m3u8)
        return [{ url: m3u8, quality: '1080p', source: 'VidStack' }]
      })
    })
    .catch(function(e) {
      console.log('[HDhub4u] VidStack error: ' + e.message)
      return []
    })
}

// ── HUBCDN extractor ──────────────────────────────────────────────────────────
// CS ref: HUBCDN.getUrl() — parses `var reurl = "<base64>"` from inline script

function extractHubCdn(url) {
  return httpGet(url, { 'Referer': url })
    .then(function(html) {
      // Find: var reurl = "BASE64STRING"
      var m = html.match(/var\s+reurl\s*=\s*["']([A-Za-z0-9+\/=]+)["']/)
      if (!m) {
        console.log('[HDhub4u] HUBCDN: no reurl found')
        return []
      }
      var videoUrl = b64decode(m[1]).trim()
      if (!videoUrl) return []
      console.log('[HDhub4u] HUBCDN → ' + videoUrl)
      return [{ url: videoUrl, quality: extractQuality(html), source: 'HUBCDN' }]
    })
    .catch(function(e) {
      console.log('[HDhub4u] HUBCDN error: ' + e.message)
      return []
    })
}

// ── BuzzServer redirect follow ────────────────────────────────────────────────
// CS ref: HubCloud parseBtn "BuzzServer" — GET link with allowRedirects=false,
// then use the hx-redirect response header as the real video URL

function resolveBuzzServer(url, quality) {
  return fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, 'Referer': url }
  })
    .then(function(r) {
      var redirect = r.headers.get('hx-redirect') || r.headers.get('location')
      var finalUrl = redirect || url
      console.log('[HDhub4u] BuzzServer → ' + finalUrl)
      return [{ url: finalUrl, quality: quality || 'HD', source: 'BuzzServer' }]
    })
    .catch(function(e) {
      console.log('[HDhub4u] BuzzServer error: ' + e.message)
      return [{ url: url, quality: quality || 'HD', source: 'BuzzServer' }]
    })
}

// ── Host-based extractor dispatcher ──────────────────────────────────────────

function extractByHost(url) {
  if (!url || url.length < 10) return Promise.resolve([])
  var host = getOrigin(url)
  if (/hubcloud/.test(host))             return extractHubCloud(url)
  if (/hubstream|hdstream4u/.test(host)) return extractVidStack(url)
  if (/hubdrive/.test(host))             return extractHubDrive(url)
  if (/hubcdn/.test(host))               return extractHubCdn(url)
  console.log('[HDhub4u] No extractor for: ' + host)
  return Promise.resolve([])
}

// ── Movie page parsing ────────────────────────────────────────────────────────
// CS ref: load() movie branch — collect h3/h4 quality links + .page-body div links

function getMovieLinks(pageUrl, domain) {
  return httpGet(pageUrl, { 'Referer': domain + '/', 'Cookie': COOKIE })
    .then(function(html) {
      var links = []

      // 1. <a> inside <h3>/<h4> whose text contains quality labels
      var hRegex = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/gi
      var m, am
      while ((m = hRegex.exec(html)) !== null) {
        var block = m[1]
        if (!/480|720|1080|2160|4[Kk]/i.test(block.replace(/<[^>]+>/g, ''))) continue
        var aRe = /href="([^"]+)"/g
        while ((am = aRe.exec(block)) !== null) {
          if (links.indexOf(am[1]) === -1) links.push(am[1])
        }
      }

      // 2. Direct hubstream / hdstream4u links anywhere in page body
      var domainRe = /href="(https?:\/\/(?:[^"]*\.)?(?:hdstream4u|hubstream)\.[^"]+)"/gi
      while ((m = domainRe.exec(html)) !== null) {
        if (links.indexOf(m[1]) === -1) links.push(m[1])
      }

      console.log('[HDhub4u] Movie raw links: ' + links.length)
      return links
    })
}

// ── TV episode page parsing ───────────────────────────────────────────────────
// CS ref: load() TV branch — parse h3/h4 for "EPiSODE N" then collect hrefs
//
// Two patterns on the site:
//   A) Episode-specific headings:  <h4>EPiSODE 3</h4> <a href="?id=...">720p</a>
//   B) Season pack headings:       <h3>All Episodes 1080p</h3> <a href="?id=...">
//      → resolve redirect → fetch index page → find h5 a for specific episode

function getEpisodeLinks(pageUrl, season, episode, domain) {
  var epNum = parseInt(episode)

  return httpGet(pageUrl, { 'Referer': domain + '/', 'Cookie': COOKIE })
    .then(function(html) {
      var directLinks = []
      var packLinks   = []

      var hRegex = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/gi
      var m
      while ((m = hRegex.exec(html)) !== null) {
        var blockHtml = m[1]
        var blockText = blockHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

        var epMatch = blockText.match(/episode\s*(\d+)/i)
        if (epMatch && parseInt(epMatch[1]) === epNum) {
          // Direct episode heading — grab all hrefs
          var aRe = /href="([^"]+)"/g
          var am
          while ((am = aRe.exec(blockHtml)) !== null) {
            if (directLinks.indexOf(am[1]) === -1) directLinks.push(am[1])
          }
        } else if (/480|720|1080|2160|4[Kk]/i.test(blockText)) {
          // Season pack / quality block — resolve to get episode index
          var idMatch = blockHtml.match(/href="([^"]*\?id=[^"]+)"/)
          if (idMatch) packLinks.push(idMatch[1])
        }
      }

      console.log('[HDhub4u] Ep' + epNum + ' direct:' + directLinks.length + ' packs:' + packLinks.length)

      if (directLinks.length > 0) return { type: 'direct', links: directLinks }
      return { type: 'pack', links: packLinks }
    })
    .then(function(result) {
      if (result.type === 'direct') return result.links

      // Resolve each pack → fetch index page → scrape h5 a for specific episode
      return Promise.all(result.links.map(function(packUrl) {
        return getRedirectLinks(packUrl)
          .then(function(indexUrl) {
            if (!indexUrl) return []
            return httpGet(indexUrl, { 'Referer': indexUrl })
              .then(function(indexHtml) {
                var epLinks = []
                var h5Re = /<h5[^>]*>([\s\S]*?)<\/h5>/gi
                var m
                while ((m = h5Re.exec(indexHtml)) !== null) {
                  var h5Text = m[1].replace(/<[^>]+>/g, '').trim()
                  var epNumMatch = h5Text.match(/episode\s*(\d+)/i)
                  if (!epNumMatch || parseInt(epNumMatch[1]) !== epNum) continue
                  var aMatch = m[1].match(/href="([^"]+)"/)
                  if (aMatch && epLinks.indexOf(aMatch[1]) === -1) epLinks.push(aMatch[1])
                }
                console.log('[HDhub4u] Pack → ep links: ' + epLinks.length)
                return epLinks
              })
          })
          .catch(function() { return [] })
      })).then(function(all) {
        return all.reduce(function(acc, r) { return acc.concat(r) }, [])
      })
    })
}

// ── Stream resolution ─────────────────────────────────────────────────────────

function resolveLink(rawUrl) {
  if (!rawUrl) return Promise.resolve([])
  var host = getOrigin(rawUrl)

  // Already a known streaming host — extract directly
  if (/hubcloud|hubstream|hdstream4u|hubdrive/.test(host)) return extractByHost(rawUrl)

  // Otherwise decode redirect first
  return getRedirectLinks(rawUrl)
    .then(function(resolved) {
      if (!resolved) return []
      return extractByHost(resolved)
    })
    .catch(function() { return [] })
}

// ── Main entry point ──────────────────────────────────────────────────────────

function getStreams(tmdbId, type, season, episode) {
  var isTv = type === 'tv' || type === 'series'

  return new Promise(function(resolve) {
    var domain

    fetchDomain()
      .then(function(d) {
        domain = d
        return getTmdbDetails(tmdbId, type)
      })
      .then(function(details) {
        if (!details || !details.title) { resolve([]); return null }
        console.log('[HDhub4u] TMDB: "' + details.title + '" (' + details.year + ')')
        return searchSite(details.title, isTv, domain)
      })
      .then(function(results) {
        if (!results || results.length === 0) { resolve([]); return null }
        var pageUrl = results[0].url
        console.log('[HDhub4u] Content page: ' + pageUrl)
        if (isTv) return getEpisodeLinks(pageUrl, season, episode, domain)
        return getMovieLinks(pageUrl, domain)
      })
      .then(function(rawLinks) {
        if (!rawLinks || rawLinks.length === 0) { resolve([]); return null }
        console.log('[HDhub4u] Resolving ' + rawLinks.length + ' link(s)...')
        return Promise.all(rawLinks.map(function(u) {
          return resolveLink(u).catch(function() { return [] })
        }))
      })
      .then(function(all) {
        if (!all) return
        var flat = all.reduce(function(acc, r) { return acc.concat(r) }, [])

        var seen = {}
        flat = flat.filter(function(s) {
          if (!s || !s.url || seen[s.url]) return false
          seen[s.url] = true
          return true
        })

        var streams = flat.map(function(s) {
          return {
            name   : '🎬 HDhub4u',
            title  : 'HDhub4u • ' + (s.source || 'Stream') + ' • ' + (s.quality || 'HD'),
            url    : s.url,
            quality: s.quality || 'HD',
            headers: { 'User-Agent': UA }
          }
        })

        console.log('[HDhub4u] Final streams: ' + streams.length)
        resolve(streams)
      })
      .catch(function(err) {
        console.error('[HDhub4u] Fatal: ' + err.message)
        resolve([])
      })
  })
}

module.exports = { getStreams }

// ── Local test runner ─────────────────────────────────────────────────────────
// Run: node providers/hdhub4u.js
// Tests each major step: domain → TMDB → search → page → links → streams

if (require.main === module) {
  // ── Override global.fetch using undici with SSL verification disabled ──────
  // undici is bundled with Node 18+ and properly handles TLS/HTTP2
  var _undici = require('undici')
  var _noSslDispatcher = new _undici.Agent({
    connect: { rejectUnauthorized: false }
  })

  global.fetch = function(url, options) {
    options = options || {}
    return _undici.fetch(url, Object.assign({ dispatcher: _noSslDispatcher }, options))
  }

  // ── Test parameters ───────────────────────────────────────────────────────
  // Set title/year directly to skip TMDB lookup (faster for local testing):
  var TEST = {
    tmdbId : '1396',       // Breaking Bad (tv)  | 27205 = Inception (movie)
    type   : 'tv',         // 'movie' or 'tv'
    season : '1',
    episode: '1',
    // Optional: set these to bypass TMDB API call entirely
    title  : 'Breaking Bad',   // set to '' to use TMDB lookup
    year   : 2008
  }

  console.log('\n══════════════════════════════════')
  console.log('  HDhub4u Test Runner')
  console.log('══════════════════════════════════')
  console.log('  TMDB ID : ' + TEST.tmdbId)
  console.log('  Type    : ' + TEST.type)
  if (TEST.type === 'tv')
    console.log('  Episode : S' + TEST.season + 'E' + TEST.episode)
  console.log('══════════════════════════════════\n')

  var _domain

  // Step 1: Domain
  console.log('Step 1 — Fetching domain...')
  fetchDomain()
    .then(function(d) {
      _domain = d
      console.log('  ✓ Domain: ' + d)

      // Step 2: TMDB (skip if title is set directly)
      if (TEST.title) {
        console.log('\nStep 2 — TMDB skipped (using hardcoded title)')
        return { title: TEST.title, year: TEST.year }
      }
      console.log('\nStep 2 — Fetching TMDB details...')
      return getTmdbDetails(TEST.tmdbId, TEST.type)
    })
    .then(function(details) {
      console.log('  ✓ Title: ' + details.title + ' (' + details.year + ')')

      // Step 3: Search
      console.log('\nStep 3 — Searching site...')
      return searchSite(details.title, TEST.type === 'tv', _domain)
    })
    .then(function(results) {
      if (!results || results.length === 0) {
        console.log('  ✗ No results found')
        process.exit(1)
      }
      var best = results[0]
      console.log('  ✓ Best match: "' + best.title + '"')
      console.log('  ✓ URL: ' + best.url)

      // Step 4: Content page
      console.log('\nStep 4 — Parsing content page...')
      if (TEST.type === 'tv')
        return getEpisodeLinks(best.url, TEST.season, TEST.episode, _domain)
      return getMovieLinks(best.url, _domain)
    })
    .then(function(rawLinks) {
      if (!rawLinks || rawLinks.length === 0) {
        console.log('  ✗ No raw links found on page')
        process.exit(1)
      }
      console.log('  ✓ Raw links: ' + rawLinks.length)
      rawLinks.forEach(function(l, i) { console.log('    [' + (i+1) + '] ' + l) })

      // Step 5: Resolve links
      console.log('\nStep 5 — Resolving ' + rawLinks.length + ' link(s)...')
      return Promise.all(rawLinks.slice(0, 4).map(function(u) {   // cap at 4 for speed
        return resolveLink(u).catch(function(e) {
          console.log('  ✗ resolve error: ' + e.message)
          return []
        })
      }))
    })
    .then(function(all) {
      var flat = all.reduce(function(acc, r) { return acc.concat(r) }, [])
      var seen = {}
      flat = flat.filter(function(s) {
        if (!s || !s.url || seen[s.url]) return false
        seen[s.url] = true
        return true
      })

      console.log('\n══════════════════════════════════')
      console.log('  FINAL STREAMS: ' + flat.length)
      console.log('══════════════════════════════════')
      flat.forEach(function(s, i) {
        console.log('  [' + (i+1) + '] ' + (s.quality || 'HD') + ' | ' + (s.source || '?') + ' | ' + s.url)
      })
      console.log('')
    })
    .catch(function(err) {
      console.error('\n  ✗ FATAL: ' + err.message)
      if (err.stack) console.error(err.stack)
      process.exit(1)
    })
}

