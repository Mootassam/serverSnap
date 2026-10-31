'use strict';
// The nginx files ServerSnap Deploy writes. Placeholders: __NAMES__ (server_name list),
// __ROOT__ (website folder), __BACKEND__ (127.0.0.1:port of the API), __PORT__ (container port),
// __WS__ (live-prices subdomain), __PROJECT__.
// "trading" is the King / SHUBH file (from king/nginx-site.sh), "normal" the Milan graborders one.

const HEADER = '# Made by ServerSnap Deploy (project __PROJECT__). Deploy again to change it, not by hand.\n';

const TRADING = HEADER + `server {
    listen 80;
    server_name __NAMES__;

    root __ROOT__;
    index index.html;

    client_max_body_size 100M;

    # APK download
    location ~* \\.apk$ {
        add_header Content-Type application/vnd.android.package-archive;
        add_header Content-Disposition "attachment";
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, HEAD";
        add_header Cache-Control "public, max-age=3600";
        add_header X-Content-Type-Options "nosniff";
        try_files $uri =404;
    }

    # Vite hashed assets (^~ so it beats the regex blocks)
    location ^~ /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
    }

    # TradingView static files
    location ^~ /tv-static/ {
        proxy_pass https://s3.tradingview.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host s3.tradingview.com;
        add_header Access-Control-Allow-Origin "*";
        proxy_hide_header x-amz-id-2;
        proxy_hide_header x-amz-request-id;
    }

    # TradingView screener API
    location ^~ /api/tv/ {
        proxy_pass https://screener-facade.tradingview.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host screener-facade.tradingview.com;
        proxy_set_header Origin "https://www.tradingview.com";
        proxy_set_header Referer "https://www.tradingview.com/";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        proxy_set_header Accept "application/json, text/plain, */*";
    }

    # TradingView scanner (live quotes fallback)
    location ^~ /api/tvscan/ {
        proxy_pass https://scanner.tradingview.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host scanner.tradingview.com;
        proxy_set_header Origin "https://www.tradingview.com";
        proxy_set_header Referer "https://www.tradingview.com/";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        proxy_set_header Accept "application/json, text/plain, */*";
        proxy_set_header Content-Type "application/json";
    }

    # TradingView WebSocket (used when the site is reached directly, without a proxy)
    location ^~ /ws/ {
        proxy_pass https://widgetdata.tradingview.com/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host widgetdata.tradingview.com;
        proxy_set_header Origin "https://www.tradingview.com";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        proxy_ssl_server_name on;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 86400;
    }

    # Socket.IO (backend)
    location ^~ /socket.io/ {
        proxy_pass http://__BACKEND__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $fwd_proto;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 86400;
    }

    # Backend API
    location ^~ /api/ {
        proxy_pass http://__BACKEND__/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $fwd_proto;
    }

    # index.html never cached: visitors always get the newest build
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Other static files
    location ~* \\.(ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot|json|txt|xml|css|js)$ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=86400";
        access_log off;
    }

    # React / Vite SPA
    location / {
        try_files $uri /index.html;
    }
}
`;

// Live prices WebSocket only, on ws.<main domain> (reaches the VPS directly, skipping any HTTPS proxy).
const TRADING_WS = HEADER + `server {
    listen 80;
    server_name __WS__;

    location ^~ /ws/ {
        proxy_pass https://widgetdata.tradingview.com/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host widgetdata.tradingview.com;
        proxy_set_header Origin "https://www.tradingview.com";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        proxy_ssl_server_name on;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 86400;
    }

    # TradingView answers with {"redirect":"widgetdata-xxx.tradingview.com"} and closes.
    # The website then reconnects here. Only widgetdata-* hosts: this is not an open proxy.
    location ~ ^/wsr/(?<tvhost>widgetdata-[a-z0-9-]+)/socket\\.io/websocket$ {
        resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
        proxy_pass https://$tvhost.tradingview.com/socket.io/websocket$is_args$args;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $tvhost.tradingview.com;
        proxy_set_header Origin "https://www.tradingview.com";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        proxy_ssl_server_name on;
        proxy_ssl_name $tvhost.tradingview.com;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 15;
    }

    location / {
        return 404;
    }
}
`;

// Keep "https" when a proxy in front (Namecheap/APISIX) says the visitor used HTTPS.
const FWD_PROTO = `# Keep "https" when a proxy in front (Namecheap/APISIX) says the visitor used HTTPS.
map $http_x_forwarded_proto $fwd_proto {
    default $http_x_forwarded_proto;
    ""      $scheme;
}
`;

const NORMAL = HEADER + `server {
    listen 80;
    server_name __NAMES__;

    root __ROOT__;
    index index.html index.htm;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # Vite hashed assets: cached for a year
    location ^~ /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
    }

    # index.html never cached: visitors always get the newest build
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Single-page website: every address opens index.html
    location / {
        try_files $uri $uri/ /index.html =404;
    }
}
`;

// The website runs inside a Docker container; nginx only adds the domain and HTTPS.
const PROXY = HEADER + `server {
    listen 80;
    server_name __NAMES__;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
    }
}
`;

const KINDS = {
  trading: { label: 'Trading (website + API + live prices)', static: true, body: TRADING },
  normal: { label: 'Normal website', static: true, body: NORMAL },
  proxy: { label: 'Website in a Docker container (port)', static: false, body: PROXY },
};

function fillTemplate(body, vars) {
  return body.replace(/__([A-Z]+)__/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

module.exports = { KINDS, TRADING_WS, FWD_PROTO, fillTemplate };
