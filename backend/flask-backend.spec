# -*- mode: python ; coding: utf-8 -*-


from PyInstaller.utils.hooks import collect_all

# Collect all selenium modules
selenium_datas, selenium_binaries, selenium_hiddenimports = collect_all('selenium')
webdriver_manager_datas, webdriver_manager_binaries, webdriver_manager_hiddenimports = collect_all('webdriver_manager')

a = Analysis(
    ['app_standalone.py'],
    pathex=[],
    binaries=selenium_binaries + webdriver_manager_binaries,
    datas=[('parsers', 'parsers'), ('templates', 'templates'), ('static', 'static'), ('../package.json', '.'), ('../protocol.json', '.')] + selenium_datas + webdriver_manager_datas,
    hiddenimports=[
        'engineio.async_drivers.threading',
        'yaml', 're', 'json', 'xml.etree.ElementTree',
        # Flask and extensions
        'flask',
        'flask.json',
        'flask_cors',
        'flask_compress',
        'flask_socketio',
        'werkzeug',
        'werkzeug.serving',
        'werkzeug.debug',
        # Other third-party dependencies
        'dotenv',
        'requests',
        'pytz',
        'paramiko',
        'openai',
        'anthropic',
        'boto3',
        'bs4',
        'markdownify',
        'beautifulsoup4',
        # Google API
        'google.auth.transport.requests',
        'google.oauth2.credentials',
        'google_auth_oauthlib.flow',
        'googleapiclient.discovery',
        'googleapiclient.errors',
        # Local backend modules
        'app',
        'extensions',
        'mustgather',
        'sosreport',
        'workflow_executor',
        'taskwarrior',
        'google_calendar',
        'log_viewer',
        'url_fetch',
        'ssh_exec',
        # Shared guards/validators (imported lazily inside routes)
        'safe_url',
        'doc_ids',
        'ssh_interactive',
        'ai_chat',
        'rag_chat',
        'vector_db',
        # Selenium imports (plus auto-collected ones)
        'selenium',
        'selenium.webdriver',
        'selenium.webdriver.chrome',
        'selenium.webdriver.chrome.webdriver',
        'selenium.webdriver.chrome.options',
        'selenium.webdriver.chrome.service',
        'selenium.webdriver.common',
        'selenium.webdriver.common.by',
        'selenium.webdriver.common.service',
        'selenium.webdriver.support',
        'selenium.webdriver.support.ui',
        'selenium.webdriver.support.expected_conditions',
        'selenium.webdriver.support.wait',
        'selenium.webdriver.remote',
        'selenium.webdriver.remote.webdriver',
        'selenium.webdriver.remote.remote_connection',
        'selenium.common',
        'selenium.common.exceptions',
        # Webdriver manager
        'webdriver_manager',
        'webdriver_manager.chrome',
        'webdriver_manager.core',
        'webdriver_manager.core.utils',
        'webdriver_manager.core.download_manager',
        'webdriver_manager.core.driver_cache',
    ] + selenium_hiddenimports + webdriver_manager_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

# Exclude system libraries to prevent GLIBCXX version conflicts
# These libraries should be loaded from the host system, not bundled from the container
excluded_binaries = []
system_libs = ['libstdc++', 'libgcc_s', 'libm.so', 'libc.so', 'libpthread', 'libdl.so', 'librt.so', 'ld-linux']
for (dest, source, kind) in a.binaries:
    # Skip system C/C++ runtime libraries
    if any(lib in dest for lib in system_libs):
        print(f"[PyInstaller] Excluding system library: {dest}")
        continue
    excluded_binaries.append((dest, source, kind))

a.binaries = excluded_binaries

pyz = PYZ(a.pure)

# Onedir build (EXE with exclude_binaries=True + COLLECT) instead of onefile:
# onefile re-extracts the entire ~185MB archive to a temp dir on every launch
# (measured 8-17s before Python even starts). Onedir keeps the files on disk
# as a normal directory, so startup skips extraction entirely.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='flask-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='flask-backend',
)
