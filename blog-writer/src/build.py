"""app.html + fonts.css -> ../index.html (배포 파일).
사용: python3 build.py            -> 실제 서버 주소로 ../index.html
      python3 build.py --test     -> 시험용 ../test/app-test.html (서버 http://localhost:8787/exec)
"""
import re, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://script.google.com/macros/s/AKfycbwuvUpvxJJXEGFh9H6H96XOa_AvDOczqEfoDFpgRtbexX2Mme_dOsYSBgTWOrhui-AaHQ/exec'
test = '--test' in sys.argv
api = 'http://localhost:8787/exec' if test else API
out = os.path.join(HERE, '..', 'test', 'app-test.html') if test else os.path.join(HERE, '..', 'index.html')
s = open(os.path.join(HERE, 'app.html'), encoding='utf8').read()
f = open(os.path.join(HERE, 'fonts.css'), encoding='utf8').read()
assert s.count('/*FONTFACE*/') == 1
t = re.search(r'<title>(.*?)</title>\n?', s); title = t.group(1); s = s.replace(t.group(0), '', 1)
s = s.replace('/*FONTFACE*/', f).replace('질문에 답하면 네이버 블로그 글 초안이 나옵니다 · 시제품', '질문에 답하면 네이버 블로그 글 초안이 나옵니다')
head = '''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>''' + title + '''</title>
<style>html{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script>
window.BW_API="''' + api + '''";
</script>
</head>
<body>
'''
open(out, 'w', encoding='utf8').write(head + s + '\n</body>\n</html>\n')
print(out, os.path.getsize(out))
