"""One-shot Crawl4AI renderer. All web bytes are brokered by the owning Node process."""

import asyncio
import base64
import contextlib
import json
import os
import re
import signal
import socket
import sys
import time
from urllib.parse import urljoin, urlsplit

# Keep the protocol separate from third-party import and crawler logging.
PROTOCOL = sys.stdout
sys.stdout = open(os.devnull, "w", encoding="utf-8")
MAX_HTML = 5 * 1024 * 1024
MAX_MESSAGE = 8 * 1024 * 1024

# Crawl4AI imports optional model packages. They must not fetch remote metadata.
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"


def deny_python_network(event, arguments):
    # Browser IPC uses subprocess pipes. Python libraries have no reason to open
    # Internet sockets: all runtime HTTP belongs exclusively to the Node broker.
    if event == "socket.connect" and arguments[0].family in (socket.AF_INET, socket.AF_INET6):
        raise PermissionError("Python renderer network is broker-only")


sys.addaudithook(deny_python_network)


def emit(message):
    PROTOCOL.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL.flush()


def parse_init(message):
    if not isinstance(message, dict):
        raise ValueError("Invalid renderer initialization")
    url = message.get("url")
    proxy = message.get("proxy_url")
    if not isinstance(url, str) or len(url) > 8192:
        raise ValueError("Invalid renderer URL")
    target = urlsplit(url)
    if target.scheme not in ("https", "http") or not target.hostname or target.username or target.password:
        raise ValueError("Renderer requires an anonymous HTTP URL")
    if not isinstance(proxy, str) or not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", proxy):
        raise ValueError("Renderer requires its local denying proxy")
    if not 1 <= urlsplit(proxy).port <= 65535:
        raise ValueError("Invalid renderer proxy port")
    deadline = message.get("deadline_ms")
    wait = message.get("wait_ms")
    if type(deadline) is not int or not 1 <= deadline <= 120000:
        raise ValueError("Invalid renderer deadline")
    if type(wait) is not int or not 0 <= wait <= 10000:
        raise ValueError("Invalid render wait")
    return message


class Broker:
    def __init__(self, reader, deadline):
        self.reader = reader
        self.deadline = deadline
        self.pending = {}
        self.serial = 0
        self.main_error = None
        self.errors = []
        self.ready_ack = asyncio.get_running_loop().create_future()
        self.ready_sent = False
        self.redirect_target = None
        self.top_redirects = 0

    async def read_responses(self):
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    raise RuntimeError("Renderer parent disconnected")
                response = json.loads(line)
                if not isinstance(response, dict):
                    raise ValueError("Invalid renderer response")
                if response.get("type") == "continue":
                    if not self.ready_sent or self.ready_ack.done():
                        raise ValueError("Unexpected renderer continue")
                    self.ready_ack.set_result(None)
                    continue
                if response.get("type") != "response":
                    raise ValueError("Invalid renderer response")
                identifier = response.get("id")
                if not isinstance(identifier, int):
                    raise ValueError("Invalid renderer response ID")
                future = self.pending.get(identifier)
                if future is None or future.done():
                    raise ValueError("Unknown renderer response ID")
                future.set_result(response)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.ready_ack.done():
                self.ready_ack.set_exception(error)
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
            raise

    async def route(self, route, request, page):
        resource = request.resource_type
        main = request.is_navigation_request() and request.frame == page.main_frame
        parsed = urlsplit(request.url)
        allowed = {"document", "script", "stylesheet", "xhr", "fetch"}
        if (request.method != "GET" or parsed.scheme not in ("http", "https")
                or parsed.username or parsed.password or resource not in allowed
                or (resource == "document" and not main)):
            await route.abort("blockedbyclient")
            return
        redirected = request.redirected_from
        depth = 0
        while redirected:
            depth += 1
            redirected = redirected.redirected_from
        self.serial += 1
        identifier = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            emit({"type": "request", "id": identifier, "url": request.url,
                  "resource_type": resource, "main_frame": main, "redirect_depth": depth + (self.top_redirects if main else 0)})
            response = await asyncio.wait_for(future, max(0.001, self.deadline - time.monotonic()))
            if "error" in response:
                error = response["error"]
                if not isinstance(error, dict) or not isinstance(error.get("code"), str):
                    raise ValueError("Invalid broker error")
                self.errors.append({"code": error["code"][:80], "resource_type": resource})
                if main:
                    self.main_error = error
                await route.abort("blockedbyclient")
                return
            status = response.get("status")
            headers = response.get("headers")
            body = response.get("body_base64")
            if type(status) is not int or not 100 <= status <= 599:
                raise ValueError("Invalid broker status")
            if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
                raise ValueError("Invalid broker headers")
            if not isinstance(body, str) or len(body) > 7 * 1024 * 1024:
                raise ValueError("Broker body too large")
            if status in (301, 302, 303, 307, 308):
                location = next((v for k, v in headers.items() if k.lower() == "location"), None)
                if main and location:
                    target = urljoin(request.url, location)
                    parsed_target = urlsplit(target)
                    if parsed_target.scheme in ("https", "http") and not parsed_target.username and not parsed_target.password:
                        self.redirect_target = target
                    else:
                        self.main_error = {"code": "FETCH_BLOCKED", "message": "Unsupported browser redirect target"}
                else:
                    self.errors.append({"code": "REDIRECT_BLOCKED", "resource_type": resource})
                # Playwright does not route a fulfilled redirect's next hop.
                # Explicit top-level arun navigation below restores per-hop policy.
                await route.abort("aborted")
                return
            # Browsers receive no credential-setting or browser-reporting instructions.
            excluded = {"set-cookie", "set-cookie2", "content-encoding", "content-length",
                        "transfer-encoding", "connection", "alt-svc", "report-to", "nel"}
            safe_headers = {k: v for k, v in headers.items() if k.lower() not in excluded}
            await route.fulfill(status=status, headers=safe_headers, body=base64.b64decode(body, validate=True))
        except asyncio.CancelledError:
            raise
        except Exception:
            if main:
                self.main_error = {"code": "FETCH_FAILED", "message": "Renderer network bridge failed"}
            with contextlib.suppress(Exception):
                await route.abort("failed")
        finally:
            self.pending.pop(identifier, None)


async def render(init, reader):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.async_crawler_strategy import AsyncPlaywrightCrawlerStrategy
    from crawl4ai.browser_manager import BrowserManager

    class BrokerBrowserManager(BrowserManager):
        """Pinned 0.9.3 adaptation: upstream config does not expose service_workers.

        Override context/launch creation to preserve Chromium security defaults and
        prevent direct egress; no upstream no-sandbox, TLS-ignore, or stealth flags.
        """
        def _build_browser_args(self):
            return {
                "headless": True,
                "chromium_sandbox": True,
                "proxy": {"server": init["proxy_url"], "bypass": "<-loopback>"},
                "args": ["--proxy-bypass-list=<-loopback>", "--disable-quic",
                         "--disable-background-networking", "--disable-component-update",
                         "--disable-domain-reliability", "--disable-sync", "--no-first-run",
                         "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                         "--disable-features=MediaRouter,OptimizationHints,DialMediaRouteProvider",
                         "--js-flags=--max-old-space-size=256"],
            }

        async def create_browser_context(self, crawlerRunConfig=None):
            return await self.browser.new_context(
                service_workers="block", accept_downloads=False, ignore_https_errors=False,
                java_script_enabled=True, permissions=[],
                user_agent="WebResearchMCP/0.5 (+anonymous public-page renderer)",
                proxy={"server": init["proxy_url"], "bypass": "<-loopback>"},
                viewport={"width": 1280, "height": 800},
            )

    deadline = time.monotonic() + init["deadline_ms"] / 1000
    broker = Broker(reader, deadline)
    response_task = asyncio.create_task(broker.read_responses())
    config = BrowserConfig(headless=True, verbose=False, enable_stealth=False,
                           use_persistent_context=False, use_managed_browser=False,
                           accept_downloads=False, ignore_https_errors=False)
    strategy = AsyncPlaywrightCrawlerStrategy(browser_config=config)
    strategy.browser_manager = BrokerBrowserManager(browser_config=config, logger=strategy.logger)
    page_holder = []

    async def attach(page, context, **kwargs):
        page_holder.append(page)
        await context.route("**/*", lambda route, request: broker.route(route, request, page))
        await context.route_web_socket("**/*", lambda socket: socket.close())
        context.on("page", lambda extra: asyncio.create_task(extra.close()) if extra != page else None)
        page.on("download", lambda download: asyncio.create_task(download.cancel()))
        # No popups or non-HTTP data channels; these are policy controls, not stealth.
        await context.add_init_script("""(() => {
          window.open = () => null;
          for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
            Object.defineProperty(window, key, {value: undefined, configurable: false});
          }
        })();""")
        if broker.ready_ack.done():
            broker.ready_ack = asyncio.get_running_loop().create_future()
        broker.ready_sent = True
        emit({"type": "ready"})
        await asyncio.wait_for(broker.ready_ack, max(0.001, deadline - time.monotonic()))
        return page

    async def limit_dom(page, **kwargs):
        size = await page.evaluate("new TextEncoder().encode(document.documentElement.outerHTML).length")
        if size > MAX_HTML:
            raise ValueError("Rendered document exceeds byte limit")
        return page

    strategy.set_hook("on_page_context_created", attach)
    strategy.set_hook("before_retrieve_html", limit_dom)
    run = CrawlerRunConfig(
        cache_mode=CacheMode.DISABLED, session_id="web-research-single-page",
        verbose=False, page_timeout=init["deadline_ms"],
        wait_until="domcontentloaded", delay_before_return_html=init["wait_ms"] / 1000,
        check_robots_txt=False, simulate_user=False, override_navigator=False, magic=False,
        process_iframes=False, scan_full_page=False, screenshot=False,
        remove_overlay_elements=False, wait_for_images=False,
    )
    try:
        async with asyncio.timeout(init["deadline_ms"] / 1000):
            async with AsyncWebCrawler(config=config, crawler_strategy=strategy) as crawler:
                target = init["url"]
                for hop in range(11):
                    broker.top_redirects = hop
                    broker.redirect_target = None
                    result = await crawler.arun(target, config=run)
                    if broker.main_error or not broker.redirect_target:
                        break
                    target = broker.redirect_target
                if broker.redirect_target and not broker.main_error:
                    broker.main_error = {"code": "FETCH_BLOCKED", "message": "Browser redirect limit exceeded"}
                if broker.main_error:
                    return {"type": "result", "success": False, "error": broker.main_error}
                if not result.success:
                    return {"type": "result", "success": False,
                            "error": {"code": "FETCH_FAILED", "message": "Crawl4AI could not render this page"}}
                html = result.html or ""
                if len(html.encode("utf-8")) > MAX_HTML:
                    raise ValueError("Rendered document exceeds byte limit")
                final_url = page_holder[0].url if page_holder else result.url
                title = await page_holder[0].title() if page_holder else ""
                markdown = result.markdown.raw_markdown if result.markdown else ""
                return {"type": "result", "success": True, "url": final_url, "html": html,
                        "title": title[:4096], "markdown": markdown[:1024 * 1024],
                        "resource_errors": broker.errors[:100]}
    finally:
        response_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await response_task


async def main():
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    reader = asyncio.StreamReader(limit=MAX_MESSAGE)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    try:
        line = await asyncio.wait_for(reader.readline(), 5)
        init = parse_init(json.loads(line))
        emit(await render(init, reader))
    except asyncio.CancelledError:
        emit({"type": "result", "success": False, "error": {"code": "CANCELLED", "message": "Renderer cancelled"}})
    except TimeoutError:
        emit({"type": "result", "success": False, "error": {"code": "TIMEOUT", "message": "Renderer deadline exceeded"}})
    except Exception as error:
        # Exception strings from upstream may contain URL secrets or page content.
        emit({"type": "result", "success": False,
              "error": {"code": "FETCH_FAILED", "message": f"Renderer failed ({type(error).__name__})"}})
    finally:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())
