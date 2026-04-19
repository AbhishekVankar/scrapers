// PirateXPlay Scraper for Nuvio
// Anime · Cartoon · Asian content (Hindi/Multi)
// Ported from: github.com/phisher98/cloudstream-extensions-phisher/Piratexplay
// NO async/await — only .then() chains

var BASE_URL = 'https://piratexplay.cc'
var TMDB_KEY = 'd80ba92bc7cefe3359668d30d06f3305'
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url, headers) {
  return fetch(url, {
    headers: Object.assign({ 'User-Agent': UA }, headers || {})
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.text()
  })
}

function httpPostRaw(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: Object.assign({
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded'
    }, headers || {}),
    body: body
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.text()
  }).then(function(text) {
    try { return JSON.parse(text) } catch(e) { return null }
  })
}

// ── Base64 decode polyfill ────────────────────────────────────────────────────
// (React Native / Hermes may not have atob)

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

// ── Utilities ─────────────────────────────────────────────────────────────────

function getOrigin(url) {
  var m = url.match(/^(https?:\/\/[^\/]+)/)
  return m ? m[1] : ''
}

function cleanTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function titleScore(candidate, query) {
  var c = cleanTitle(candidate)
  var q = cleanTitle(query)
  if (c === q) return 3
  if (c.indexOf(q) === 0 || q.indexOf(c) === 0) return 2
  if (c.indexOf(q) !== -1 || q.indexOf(c) !== -1) return 1
  return 0
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
        year: parseInt((d.release_date || d.first_air_date || '0000').split('-')[0])
      }
    })
}

// ── Search ────────────────────────────────────────────────────────────────────
// CS ref: search() → GET /?s=QUERY → parse #movies-a ul li

function searchSite(title, isTv) {
  var url = BASE_URL + '/?s=' + encodeURIComponent(title)
  console.log('[PirateXPlay] Search: ' + url)
  return httpGet(url, { 'Referer': BASE_URL + '/' })
    .then(function(html) {
      var results = []

      // Grab the #movies-a container to avoid nav/footer noise
      var containerMatch = html.match(/id="movies-a"([\s\S]*?)(?=<footer|id="footer|class="footer)/m)
      var listHtml = containerMatch ? containerMatch[1] : html

      // Each result is an <li> with an <a href> and <h2> title
      // Accept BOTH absolute (https://piratexplay.cc/...) and relative (/slug/) hrefs
      var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g
      var m
      while ((m = liRegex.exec(listHtml)) !== null) {
        var liHtml = m[1]
        var hrefMatch = liHtml.match(/href="((?:https?:\/\/piratexplay\.cc)?\/[^"]+)"/)
        var titleMatch = liHtml.match(/<h2[^>]*>([^<]+)<\/h2>/)
        if (!hrefMatch || !titleMatch) continue

        var itemUrl = hrefMatch[1]
        // Normalise relative → absolute
        if (itemUrl.indexOf('http') !== 0) itemUrl = BASE_URL + itemUrl
        var itemTitle = titleMatch[1].trim()

        results.push({ url: itemUrl, title: itemTitle })
      }

      console.log('[PirateXPlay] Raw results: ' + results.length)

      // Type filter: CS uses url.contains("movie") → Movie, else → TvSeries
      var typed = results.filter(function(r) {
        var isMovieUrl = r.url.indexOf('/movie') !== -1
        return isTv ? !isMovieUrl : isMovieUrl
      })

      // Fall back to all results if type filter wipes everything
      // (handles edge cases where the site URL pattern doesn't match)
      var candidates = typed.length > 0 ? typed : results
      console.log('[PirateXPlay] After type filter: ' + candidates.length + (typed.length === 0 ? ' (fallback)' : ''))

      candidates.sort(function(a, b) {
        return titleScore(b.title, title) - titleScore(a.title, title)
      })

      if (candidates.length > 0) {
        console.log('[PirateXPlay] Best match: "' + candidates[0].title + '" → ' + candidates[0].url)
      }
      return candidates
    })
}

// ── Episode resolution ────────────────────────────────────────────────────────
// CS ref: load() → select div.season-swiper a.season-btn → GET mainUrl+seasonUrl
//         → #episode_by_temp li → span text "SxE" → a href

function findEpisodeInHtml(html, targetSeason, targetEpisode) {
  var s = parseInt(targetSeason)
  var e = parseInt(targetEpisode)

  // Real site structure (confirmed from HTML inspection):
  //   <li>
  //     <article class="episodes ...">
  //       <span class="num-epi">
  //           1x1                    ← whitespace around the code
  //       </span>
  //       <a href="/episode/one-piece-season-1-37854-1x1/" class="lnk-blk"></a>
  //     </article>
  //   </li>

  var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g
  var m
  while ((m = liRegex.exec(html)) !== null) {
    var liHtml = m[1]

    // Match <span class="num-epi"> with \s* to handle surrounding whitespace
    var spanMatch = liHtml.match(/<span[^>]*class="[^"]*num-epi[^"]*"[^>]*>\s*(\d+)[xX](\d+)\s*<\/span>/)
    if (!spanMatch) continue
    if (parseInt(spanMatch[1]) !== s || parseInt(spanMatch[2]) !== e) continue

    // Grab the episode href (relative like /episode/.../)
    var hrefMatch = liHtml.match(/href="(\/episode\/[^"]+)"/)
    if (!hrefMatch) hrefMatch = liHtml.match(/href="([^"]+)"/)
    if (!hrefMatch) continue

    var epUrl = hrefMatch[1]
    if (epUrl.indexOf('http') !== 0) epUrl = BASE_URL + epUrl
    console.log('[PirateXPlay] Episode URL: ' + epUrl)
    return epUrl
  }

  return null
}

function getEpisodeUrl(showUrl, season, episode) {
  return httpGet(showUrl, { 'Referer': BASE_URL + '/' })
    .then(function(html) {
      // Season links: div.season-swiper a.season-btn (relative hrefs)
      var seasonLinks = []
      // Match both attribute orders
      var patterns = [
        /class="season-btn"[^>]*href="([^"]+)"/g,
        /href="([^"]+)"[^>]*class="season-btn"/g
      ]
      patterns.forEach(function(re) {
        var m
        while ((m = re.exec(html)) !== null) {
          if (seasonLinks.indexOf(m[1]) === -1) seasonLinks.push(m[1])
        }
      })

      console.log('[PirateXPlay] Season links: ' + seasonLinks.length)

      if (seasonLinks.length === 0) {
        // No season switcher — episodes may be directly on the page
        var direct = findEpisodeInHtml(html, season, episode)
        return direct
      }

      // Season 1 → index 0, Season 2 → index 1, …
      var idx = Math.max(0, parseInt(season) - 1)
      var seasonRel = seasonLinks[idx] || seasonLinks[0]
      var seasonFull = seasonRel.indexOf('http') === 0 ? seasonRel : BASE_URL + seasonRel
      console.log('[PirateXPlay] Fetching season page: ' + seasonFull)

      return httpGet(seasonFull, { 'Referer': showUrl })
        .then(function(seasonHtml) {
          return findEpisodeInHtml(seasonHtml, season, episode)
        })
    })
}

// ── Iframe extraction ─────────────────────────────────────────────────────────
// CS ref: loadLinks() → document.select("iframe") → src.ifBlank{data-src}.substringAfterLast("url=")

function getIframesFromPage(pageUrl) {
  return httpGet(pageUrl, { 'Referer': BASE_URL + '/' })
    .then(function(html) {
      var embedUrls = []
      var iframeRegex = /<iframe[^>]+>/gi
      var m
      while ((m = iframeRegex.exec(html)) !== null) {
        var tag = m[0]
        // src takes priority, fall back to data-src (matches .ifBlank{} in Kotlin)
        var srcMatch = tag.match(/\bsrc="([^"]+)"/) || tag.match(/\bdata-src="([^"]+)"/)
        if (!srcMatch) continue

        var src = srcMatch[1].trim()
        if (!src || src === 'about:blank' || src === '') continue

        // CS: substringAfterLast("url=") — strips player wrapper
        if (src.indexOf('url=') !== -1) {
          src = src.split('url=').pop()
        }

        try { src = decodeURIComponent(src) } catch(e) {}
        if (src.indexOf('http') === 0) embedUrls.push(src)
      }

      console.log('[PirateXPlay] Iframes on page: ' + embedUrls.length)
      return embedUrls
    })
}

// ── Extractors ────────────────────────────────────────────────────────────────

// AWSStream / ascdn21 — POST hash → videoSource M3U8
// CS ref: AWSStream.getUrl() in Extractor.kt
function extractAWSStream(url) {
  var hash = url.split('/').pop().split('?')[0]
  var host = getOrigin(url)
  console.log('[PirateXPlay] AWSStream: ' + host + ' hash=' + hash)

  return httpPostRaw(
    host + '/player/index.php?data=' + hash + '&do=getVideo',
    'hash=' + hash + '&r=' + encodeURIComponent(host + '/'),
    { 'X-Requested-With': 'XMLHttpRequest', 'Referer': host + '/', 'Origin': host }
  ).then(function(data) {
    if (data && data.videoSource) {
      console.log('[PirateXPlay] AWSStream M3U8 found')
      return [{ url: data.videoSource, quality: '1080p', source: 'AWSStream' }]
    }
    return []
  }).catch(function(e) {
    console.log('[PirateXPlay] AWSStream error: ' + e.message)
    return []
  })
}

// GDMirrorbot — POST sid → JSON with siteUrls + mresult → sub-extractor URLs
// CS ref: GDMirrorbot.getUrl() + extractSidsAndHost() in Extractor.kt
function extractGDMirrorbot(url, host) {
  var sid = url.indexOf('/embed/') !== -1
    ? url.split('/embed/').pop().split('?')[0]
    : url.split('/').pop().split('?')[0]

  console.log('[PirateXPlay] GDMirrorbot: host=' + host + ' sid=' + sid)

  return httpPostRaw(
    host + '/embedhelper.php',
    'sid=' + encodeURIComponent(sid),
    { 'Referer': host + '/', 'X-Requested-With': 'XMLHttpRequest' }
  ).then(function(data) {
    if (!data) return []

    var siteUrls = data.siteUrls || {}
    var mresult = data.mresult

    // mresult may be a base64-encoded JSON string or already an object
    if (typeof mresult === 'string') {
      try { mresult = JSON.parse(b64decode(mresult)) } catch(e) { mresult = {} }
    }
    if (!mresult || typeof mresult !== 'object') return []

    // Intersect siteUrls keys with mresult keys → build full sub-URLs
    var subUrls = []
    Object.keys(siteUrls).forEach(function(key) {
      if (!mresult[key]) return
      var base = (siteUrls[key] || '').replace(/\/$/, '')
      var path = (mresult[key] || '').replace(/^\//, '')
      if (base && path) subUrls.push({ key: key, url: base + '/' + path })
    })

    console.log('[PirateXPlay] GDMirrorbot sub-URLs: ' + subUrls.length)

    // Limit parallel requests — take up to 4
    return Promise.all(subUrls.slice(0, 4).map(function(item) {
      return extractStreams(item.url).catch(function() { return [] })
    })).then(function(all) {
      return all.reduce(function(acc, r) { return acc.concat(r) }, [])
    })
  }).catch(function(e) {
    console.log('[PirateXPlay] GDMirrorbot error: ' + e.message)
    return []
  })
}

// Streamwish / Filesim (Pixdrive, Ghbrisk) — parse M3U8 from JW player sources
// CS ref: Filesim (base class of Pixdrive/Ghbrisk) in CloudStream extractors
function extractStreamwish(url) {
  return httpGet(url, { 'Referer': url })
    .then(function(html) {
      // Method 1: JW sources array  →  {file:"..."}
      var m = html.match(/['"]\s*file\s*['"]\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
      if (m) return [{ url: m[1], quality: '1080p', source: 'Streamwish' }]

      // Method 2: sources:[{file:'...'}]  style
      var m2 = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)
      if (m2) return [{ url: m2[1], quality: '1080p', source: 'Streamwish' }]

      // Method 3: bare m3u8 URL in script block
      var m3 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i)
      if (m3) return [{ url: m3[1], quality: '1080p', source: 'Streamwish' }]

      return []
    }).catch(function(e) {
      console.log('[PirateXPlay] Streamwish error: ' + e.message)
      return []
    })
}

// PiratexplayExtractor — nested #playerFrame iframe → recurse
// CS ref: PiratexplayExtractor.getUrl() in Extractor.kt
function extractPiratexplayPlayer(url) {
  return httpGet(url, { 'Referer': BASE_URL + '/' })
    .then(function(html) {
      // Select #playerFrame src
      var m = html.match(/id="playerFrame"[^>]+src="([^"]+)"/)
        || html.match(/id="playerFrame"[^>]+data-src="([^"]+)"/)
      if (!m) return []
      var inner = m[1]
      if (inner.indexOf('http') !== 0) inner = BASE_URL + inner
      return extractStreams(inner)
    }).catch(function(e) {
      console.log('[PirateXPlay] PlayerFrame error: ' + e.message)
      return []
    })
}

// MyAnimeworld — nested iframe → recurse
// CS ref: MyAnimeworld.getUrl() in Extractor.kt
function extractMyAnimeworld(url) {
  return httpGet(url, { 'Referer': BASE_URL + '/' })
    .then(function(html) {
      var m = html.match(/<iframe[^>]+src="([^"]+)"/)
        || html.match(/<iframe[^>]+data-src="([^"]+)"/)
      if (!m) return []
      var inner = m[1]
      if (inner.indexOf('http') !== 0) return []
      return extractStreams(inner)
    }).catch(function(e) {
      console.log('[PirateXPlay] MyAnimeworld error: ' + e.message)
      return []
    })
}

// ── Extractor dispatcher ──────────────────────────────────────────────────────

function extractStreams(embedUrl) {
  var host = getOrigin(embedUrl)
  console.log('[PirateXPlay] Dispatch extractor for: ' + host)

  // AWSStream hosts: as-cdn*.top  or  awstream.net  (ascdn21 is a subclass)
  if (/as-cdn\d+\.top|awstream\.net/.test(host)) {
    return extractAWSStream(embedUrl)
  }

  // GDMirrorbot and its subclasses: Techinmind, Iqsmartgamesstreams/pro
  if (/gdmirrorbot\.nl|techinmind\.space|iqsmartgames\.com/.test(host)) {
    return extractGDMirrorbot(embedUrl, host)
  }

  // Streamwish-compatible: Pixdrive, Ghbrisk, Cloudy (VidStack has same pattern)
  if (/pixdrive\.cfd|ghbrisk\.com|cloudy\.upns\.one|streamwish/.test(host)) {
    return extractStreamwish(embedUrl)
  }

  // PiratexplayExtractor — self-hosted player with #playerFrame
  if (/piratexplay\.cc/.test(host)) {
    return extractPiratexplayPlayer(embedUrl)
  }

  // MyAnimeworld — nested iframe
  if (/myanimeworld\.in/.test(host)) {
    return extractMyAnimeworld(embedUrl)
  }

  // Generic fallback: try Streamwish pattern (covers VidStack, etc.)
  console.log('[PirateXPlay] Unknown host, trying generic: ' + host)
  return extractStreamwish(embedUrl)
}

// ── Main entry point ──────────────────────────────────────────────────────────

function getStreams(tmdbId, type, season, episode) {
  var isTv = type === 'tv' || type === 'series'

  return new Promise(function(resolve) {
    getTmdbDetails(tmdbId, type)
      .then(function(details) {
        if (!details || !details.title) {
          console.log('[PirateXPlay] No TMDB details')
          resolve([])
          return null
        }
        console.log('[PirateXPlay] TMDB: "' + details.title + '" (' + details.year + ')')
        return searchSite(details.title, isTv)
      })
      .then(function(results) {
        if (!results || results.length === 0) {
          console.log('[PirateXPlay] No search results')
          resolve([])
          return null
        }

        var best
        if (!isTv) {
          best = results[0]
        } else {
          // piratexplay has one page per season (e.g. /series/one-piece-season-2-xxxx)
          // Try to find a result whose title or URL mentions the requested season number
          var sNum = parseInt(season)
          var seasonPatterns = [
            'season-' + sNum,           // URL slug: season-2
            'season ' + sNum,           // Title: "Season 2"
            's' + String(sNum).padStart(2, '0') // S02
          ]
          var seasonMatch = null
          for (var i = 0; i < results.length; i++) {
            var r = results[i]
            var combined = (r.title + ' ' + r.url).toLowerCase()
            for (var j = 0; j < seasonPatterns.length; j++) {
              if (combined.indexOf(seasonPatterns[j]) !== -1) {
                seasonMatch = r
                break
              }
            }
            if (seasonMatch) break
          }
          // Season 1 fallback: if no "season-N" slug found, take the best title match
          // (season 1 pages are often just /series/show-name without a season suffix)
          best = seasonMatch || results[0]
          console.log('[PirateXPlay] Season ' + sNum + ' page: ' + (seasonMatch ? 'matched' : 'fallback') + ' → ' + best.url)
        }

        console.log('[PirateXPlay] Content page: ' + best.url)

        if (!isTv) return best.url
        // TV: resolve specific episode URL from the season page
        return getEpisodeUrl(best.url, season, episode)
      })
      .then(function(targetUrl) {
        if (!targetUrl) {
          console.log('[PirateXPlay] Episode/page URL not found')
          resolve([])
          return null
        }
        console.log('[PirateXPlay] Scraping: ' + targetUrl)
        return getIframesFromPage(targetUrl)
      })
      .then(function(embedUrls) {
        if (!embedUrls || embedUrls.length === 0) {
          console.log('[PirateXPlay] No embed URLs found')
          resolve([])
          return null
        }
        return Promise.all(embedUrls.map(function(url) {
          return extractStreams(url).catch(function() { return [] })
        }))
      })
      .then(function(allResults) {
        if (!allResults) return
        var flat = allResults.reduce(function(acc, r) { return acc.concat(r) }, [])
        // Deduplicate by URL
        var seen = {}
        flat = flat.filter(function(s) {
          if (!s || !s.url || seen[s.url]) return false
          seen[s.url] = true
          return true
        })

        var streams = flat.map(function(s) {
          return {
            name: '🏴‍☠️ PirateXPlay',
            title: 'PirateXPlay • ' + (s.source || 'Stream') + ' • ' + (s.quality || 'HD'),
            url: s.url,
            quality: s.quality || 'HD',
            headers: {
              'Referer': BASE_URL + '/',
              'User-Agent': UA
            }
          }
        })

        console.log('[PirateXPlay] Final streams: ' + streams.length)
        resolve(streams)
      })
      .catch(function(err) {
        console.error('[PirateXPlay] Fatal: ' + err.message)
        resolve([])
      })
  })
}

module.exports = { getStreams }

// ── Local test runner (only runs via: node providers/piratexplay.js) ──────────
if (require.main === module) {
  // ✏️  Edit these to test any content.
  // Set title+year to SKIP the TMDB fetch (useful if TMDB is blocked in Node).
  var TEST = {
    tmdbId : '37854',     // TMDB ID (used only if title is blank)
    type   : 'tv',        // 'tv' | 'movie'
    season : '1',
    episode: '1',
    title  : 'One Piece', // ← set this to skip TMDB lookup
    year   : 1999         // ← set this to skip TMDB lookup
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function printResult(streams) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    if (!streams || streams.length === 0) {
      console.log('  ✗  No streams found')
    } else {
      console.log('  ✓  ' + streams.length + ' stream(s) found\n')
      streams.forEach(function(s, i) {
        console.log('  [' + (i + 1) + '] ' + s.quality + ' · ' + (s.title || ''))
        console.log('      URL  : ' + s.url)
        if (s.headers && s.headers['Referer']) {
          console.log('      REF  : ' + s.headers['Referer'])
        }
        console.log()
      })
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  }

  // Run the pipeline step by step so errors are easy to pinpoint
  function runTest(title, year) {
    var isTv = TEST.type === 'tv' || TEST.type === 'series'

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  PirateXPlay — local test')
    console.log('  "' + title + '" (' + year + ') · ' + TEST.type.toUpperCase()
      + (isTv ? ' · S' + TEST.season + 'E' + TEST.episode : ''))
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    // Step 1 – search
    searchSite(title, isTv)
      .then(function(results) {
        if (!results || results.length === 0) {
          console.error('[TEST] ✗ Step 1 failed: no search results')
          printResult([])
          return null
        }
        console.log('[TEST] ✓ Step 1 – search OK (' + results.length + ' results)')

        // Step 2 – pick correct season/page
        var best
        if (!isTv) {
          best = results[0]
        } else {
          var sNum = parseInt(TEST.season)
          var seasonPatterns = ['season-' + sNum, 'season ' + sNum, 's' + String(sNum).padStart(2, '0')]
          var seasonMatch = null
          for (var i = 0; i < results.length; i++) {
            var combined = (results[i].title + ' ' + results[i].url).toLowerCase()
            for (var j = 0; j < seasonPatterns.length; j++) {
              if (combined.indexOf(seasonPatterns[j]) !== -1) { seasonMatch = results[i]; break }
            }
            if (seasonMatch) break
          }
          best = seasonMatch || results[0]
          console.log('[TEST] ✓ Step 2 – season page: ' + best.url)
        }

        if (!isTv) return best.url

        // Step 3 – episode URL
        return getEpisodeUrl(best.url, TEST.season, TEST.episode)
          .then(function(epUrl) {
            if (!epUrl) {
              console.error('[TEST] ✗ Step 3 failed: episode not found on season page')
              return null
            }
            console.log('[TEST] ✓ Step 3 – episode URL: ' + epUrl)
            return epUrl
          })
      })
      .then(function(targetUrl) {
        if (!targetUrl) { printResult([]); return null }

        // Step 4 – iframes
        return getIframesFromPage(targetUrl)
          .then(function(embedUrls) {
            if (!embedUrls || embedUrls.length === 0) {
              console.error('[TEST] ✗ Step 4 failed: no iframes on page')
              printResult([])
              return null
            }
            console.log('[TEST] ✓ Step 4 – embed URLs: ' + embedUrls.length)
            embedUrls.forEach(function(u, i) { console.log('         [' + (i+1) + '] ' + u) })

            // Step 5 – extract streams
            return Promise.all(embedUrls.map(function(u) {
              return extractStreams(u).catch(function(e) {
                console.error('[TEST] ✗ extractor failed for ' + u + ': ' + e.message)
                return []
              })
            }))
          })
      })
      .then(function(allResults) {
        if (!allResults) return
        var flat = allResults.reduce(function(acc, r) { return acc.concat(r) }, [])
        var seen = {}
        flat = flat.filter(function(s) {
          if (!s || !s.url || seen[s.url]) return false
          seen[s.url] = true
          return true
        })
        var streams = flat.map(function(s) {
          return {
            name   : '🏴‍☠️ PirateXPlay',
            title  : 'PirateXPlay • ' + (s.source || 'Stream') + ' • ' + (s.quality || 'HD'),
            url    : s.url,
            quality: s.quality || 'HD',
            headers: { 'Referer': BASE_URL + '/', 'User-Agent': UA }
          }
        })
        console.log('[TEST] ✓ Step 5 – streams extracted: ' + streams.length)
        printResult(streams)
      })
      .catch(function(err) {
        console.error('[TEST] ✗ Unexpected error: ' + err.message)
        console.error(err.stack || '')
        printResult([])
      })
  }

  // If title is provided, skip TMDB and run directly.
  // Otherwise fetch TMDB first (requires Node 18+ with working fetch).
  if (TEST.title) {
    runTest(TEST.title, TEST.year)
  } else {
    console.log('[TEST] Fetching TMDB details for id ' + TEST.tmdbId + '...')
    getTmdbDetails(TEST.tmdbId, TEST.type)
      .then(function(d) {
        if (!d || !d.title) { console.error('[TEST] ✗ TMDB lookup failed'); return }
        runTest(d.title, d.year)
      })
      .catch(function(e) {
        console.error('[TEST] ✗ TMDB fetch error: ' + e.message)
        console.error('      → Set TEST.title and TEST.year to skip TMDB lookup')
      })
  }
}