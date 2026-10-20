"""app.html + 글꼴 + mp4-muxer -> ../index.html (배포 파일).
사용: python3 build.py
글꼴은 블로그 글쓰기 앱의 fonts.css(Gmarket Sans)를 그대로 쓴다.
"""
import re, os
HERE = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(HERE, '..', 'index.html')
s = open(os.path.join(HERE, 'app.html'), encoding='utf8').read()
f = open(os.path.join(HERE, '..', '..', 'blog-writer', 'src', 'fonts.css'), encoding='utf8').read()
m = open(os.path.join(HERE, 'vendor', 'mp4-muxer.js'), encoding='utf8').read()
assert s.count('/*FONTFACE*/') == 1 and s.count('/*MP4MUXER*/') == 1
t = re.search(r'<title>(.*?)</title>\n?', s); title = t.group(1); s = s.replace(t.group(0), '', 1)
s = s.replace('/*FONTFACE*/', f).replace('/*MP4MUXER*/', m)
head = '''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>''' + title + '''</title>
<style>html{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
'''
open(out, 'w', encoding='utf8').write(head + s + '\n</body>\n</html>\n')
print(out, os.path.getsize(out))
