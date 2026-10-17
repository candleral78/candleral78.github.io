"""app.html + 글쓰기 앱의 fonts.css -> ../index.html (배포 파일).
사용: python3 build.py            -> 실제 서버 주소로 ../index.html
      python3 build.py --test     -> 시험용 ../test/app-test.html (서버 http://localhost:8788/exec)
실제 서버 주소는 Apps Script "배포 > 웹 앱" 주소입니다. 바뀌면 아래 API만 고칩니다.
"""
import re, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://script.google.com/macros/s/AKfycbzrizvMnzZnA3GfbxRr1xPnhn0MiTwF4Wz-oL7VSDMiGg2nf5gkn7fz2oA3UAR22dyZ2Q/exec'
test = '--test' in sys.argv
api = 'http://localhost:8788/exec' if test else API
out = os.path.join(HERE, '..', 'test', 'app-test.html') if test else os.path.join(HERE, '..', 'index.html')
s = open(os.path.join(HERE, 'app.html'), encoding='utf8').read()
f = open(os.path.join(HERE, '..', '..', 'blog-writer', 'src', 'fonts.css'), encoding='utf8').read()
assert s.count('/*FONTFACE*/') == 1
t = re.search(r'<title>(.*?)</title>\n?', s); title = t.group(1); s = s.replace(t.group(0), '', 1)
s = s.replace('/*FONTFACE*/', f)
head = '''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>''' + title + '''</title>
<style>html{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script>
window.BR_API="''' + api + '''";
</script>
</head>
<body>
'''
open(out, 'w', encoding='utf8').write(head + s + '\n</body>\n</html>\n')
print(out, os.path.getsize(out))
