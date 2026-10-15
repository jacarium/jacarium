"""URL fetch / markdown conversion route (requests with Selenium fallback)."""
from flask import Blueprint, request, jsonify

from extensions import debug_print

url_fetch = Blueprint('url_fetch', __name__)


@url_fetch.route("/api/fetch-url", methods=["POST"])
def fetch_url():
    """Fetch and convert URL content to markdown for AI processing"""
    try:
        import requests
        from bs4 import BeautifulSoup
        from markdownify import markdownify as md

        data = request.json
        url = data.get('url', '')

        if not url:
            return jsonify({"error": "URL is required"}), 400

        # SSRF guard (backend/safe_url.py): only http(s), every resolved
        # address must be public, every redirect hop is re-validated, and
        # the body is capped before it is parsed or handed to the AI.
        from safe_url import UnsafeUrlError, safe_request, DEFAULT_MAX_BYTES

        try:
            from safe_url import validate_url
            validate_url(url)
        except UnsafeUrlError as e:
            return jsonify({"error": str(e)}), 400

        html_content = None

        # First try with requests (faster)
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            try:
                response = safe_request('GET', url, headers=headers, timeout=30)
            except UnsafeUrlError as e:
                return jsonify({"error": str(e)}), 400
            except ValueError as e:
                # Response too large / too many redirects
                return jsonify({"error": f"Failed to fetch URL: {e}"}), 400
            response.raise_for_status()
            html_content = response.text
            debug_print(f"[Fetch URL] Successfully fetched with requests: {url}")
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 403:
                print(f"[Fetch URL] Got 403, trying with Selenium: {url}")
                # Fallback to Selenium for bot-protected sites
                try:
                    from selenium import webdriver
                    from selenium.webdriver.chrome.options import Options
                    from selenium.webdriver.chrome.service import Service
                    from selenium.webdriver.common.by import By
                    from selenium.webdriver.support.ui import WebDriverWait
                    from selenium.webdriver.support import expected_conditions as EC
                    try:
                        from webdriver_manager.chrome import ChromeDriverManager
                        use_driver_manager = True
                    except ImportError:
                        use_driver_manager = False
                        print("[Fetch URL] webdriver-manager not available, will try system chromedriver")
                except ImportError as import_error:
                    print(f"[Fetch URL] Selenium not available: {import_error}")
                    error_msg = "URL is protected and requires browser automation support.\n\n"
                    error_msg += "Selenium module is missing. This should be included in the app.\n"
                    error_msg += "If you built the app yourself, make sure to run './rebuild.sh' to include all dependencies.\n\n"
                    error_msg += "Also ensure Chromium is installed:\n"
                    error_msg += "• Fedora/RHEL: sudo dnf install chromium\n"
                    error_msg += "• Ubuntu/Debian: sudo apt install chromium-browser"
                    return jsonify({"error": error_msg}), 403

                try:
                    chrome_options = Options()
                    chrome_options.add_argument('--headless')
                    chrome_options.add_argument('--no-sandbox')
                    chrome_options.add_argument('--disable-dev-shm-usage')
                    chrome_options.add_argument('--disable-blink-features=AutomationControlled')
                    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
                    chrome_options.add_experimental_option('useAutomationExtension', False)

                    # Try to create Chrome driver
                    if use_driver_manager:
                        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=chrome_options)
                    else:
                        # Try system chromedriver or chromium
                        driver = webdriver.Chrome(options=chrome_options)

                    driver.get(url)

                    # Wait for page to load
                    WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.TAG_NAME, "body"))
                    )

                    html_content = driver.page_source
                    driver.quit()
                    debug_print(f"[Fetch URL] Successfully fetched with Selenium: {url}")
                except Exception as selenium_error:
                    print(f"[Fetch URL] Selenium failed: {selenium_error}")
                    error_msg = f"URL is protected and requires a browser to access.\n\n"
                    error_msg += f"Error: {str(selenium_error)}\n\n"
                    error_msg += "To fix this, install Chromium:\n"
                    error_msg += "• Fedora/RHEL: sudo dnf install chromium\n"
                    error_msg += "• Ubuntu/Debian: sudo apt install chromium-browser\n"
                    error_msg += "• Or install Google Chrome from: https://www.google.com/chrome/"
                    return jsonify({"error": error_msg}), 403
            else:
                raise

        if not html_content:
            return jsonify({"error": "Failed to fetch URL content"}), 500

        # The Selenium path returns the rendered page source uncapped; apply
        # the same size ceiling before parsing.
        if len(html_content) > DEFAULT_MAX_BYTES:
            html_content = html_content[:DEFAULT_MAX_BYTES]

        # Parse HTML
        soup = BeautifulSoup(html_content, 'html.parser')

        # Remove script and style elements
        for script in soup(["script", "style", "nav", "footer", "header"]):
            script.decompose()

        # Get page title
        title = soup.title.string if soup.title else "Documentation"

        # Get main content - try common content containers
        main_content = None
        for selector in ['main', 'article', '.documentation', '.content', '#content', 'body']:
            main_content = soup.select_one(selector)
            if main_content:
                break

        if not main_content:
            main_content = soup.body if soup.body else soup

        # Convert to markdown
        markdown_content = md(str(main_content), heading_style="ATX")

        # Clean up excessive newlines
        import re
        markdown_content = re.sub(r'\n{3,}', '\n\n', markdown_content)
        markdown_content = markdown_content.strip()

        # Limit content size (to avoid token limits)
        max_chars = 50000  # Approx 12k tokens
        if len(markdown_content) > max_chars:
            markdown_content = markdown_content[:max_chars] + "\n\n[Content truncated due to length...]"

        return jsonify({
            "content": markdown_content,
            "title": title,
            "url": url
        })

    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Failed to fetch URL: {str(e)}"}), 500
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[Fetch URL Error] {error_trace}")
        return jsonify({"error": f"Failed to process URL: {str(e)}"}), 500


# Workflow REST API nodes for the app in a browser: the desktop proxies
# them through the Electron main process ('workflow-http-request' in
# electron/main.cjs, electron/safe-request.cjs); here the same request goes
# through safe_url.safe_request (SSRF guard, redirect and size limits;
# JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS opens private ranges, as on
# the desktop).
_WORKFLOW_HTTP_METHODS = ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')
_WORKFLOW_HTTP_MAX_BODY = 4 * 1024 * 1024


@url_fetch.route("/api/workflow/http-request", methods=["POST"])
def workflow_http_request():
    import json
    from safe_url import UnsafeUrlError, safe_request, workflow_private_urls_allowed

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object expected"}), 400
    url = payload.get('url')
    if not isinstance(url, str) or not url.strip():
        return jsonify({"error": "URL is required"}), 400
    method = str(payload.get('method') or 'GET').upper()
    if method not in _WORKFLOW_HTTP_METHODS:
        return jsonify({"error": f"Unsupported method: {method}"}), 400
    raw_headers = payload.get('headers') or {}
    if not isinstance(raw_headers, dict):
        return jsonify({"error": "headers must be an object"}), 400
    headers = {}
    for name, value in raw_headers.items():
        if not isinstance(name, str) or not isinstance(value, (str, int, float)):
            return jsonify({"error": "header names and values must be strings"}), 400
        if any(ch in name for ch in '\r\n') or any(ch in str(value) for ch in '\r\n'):
            return jsonify({"error": "header contains a line break"}), 400
        headers[name] = str(value)
    body = payload.get('body')
    if body is not None and not isinstance(body, str):
        body = json.dumps(body)
    if body is not None and len(body.encode('utf-8')) > _WORKFLOW_HTTP_MAX_BODY:
        return jsonify({"error": "request body too large"}), 413
    try:
        response = safe_request(method, url.strip(), headers=headers, data=body, timeout=30,
                                allow_private=workflow_private_urls_allowed())
    except UnsafeUrlError as exc:
        return jsonify({"error": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:  # requests exceptions: DNS, refused, timeout
        return jsonify({"error": f"Request failed: {exc.__class__.__name__}"}), 502
    content_type = (response.headers or {}).get('content-type', '') or ''
    text = response.text
    out_body = text
    if 'application/json' in content_type:
        try:
            out_body = json.loads(text)
        except ValueError:
            out_body = text
    return jsonify({
        "ok": response.ok,
        "status": response.status_code,
        "statusText": response.reason or '',
        "body": out_body,
    })
