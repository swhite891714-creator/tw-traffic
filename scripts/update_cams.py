# 自動更新攝影機清單：從交通部 TDX 平台抓國道、省道、各縣市市區攝影機
# 由 GitHub Actions 定時執行，輸出 data/cams.json 給網頁的「更新」按鈕讀取
import json, time, urllib.request, urllib.error, os, re, datetime

BASE = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/'
# TDX 城市代碼 → 中文縣市名稱
CITIES = {
    'Taipei': '台北市', 'NewTaipei': '新北市', 'Taoyuan': '桃園市', 'Taichung': '台中市', 'Tainan': '台南市', 'Kaohsiung': '高雄市',
    'Keelung': '基隆市', 'Hsinchu': '新竹市', 'HsinchuCounty': '新竹縣', 'MiaoliCounty': '苗栗縣', 'ChanghuaCounty': '彰化縣',
    'NantouCounty': '南投縣', 'YunlinCounty': '雲林縣', 'ChiayiCounty': '嘉義縣', 'Chiayi': '嘉義市', 'PingtungCounty': '屏東縣',
    'YilanCounty': '宜蘭縣', 'HualienCounty': '花蓮縣', 'TaitungCounty': '台東縣', 'KinmenCounty': '金門縣', 'PenghuCounty': '澎湖縣',
    'LienchiangCounty': '連江縣',
}
UA = {'User-Agent': 'tw-traffic-updater (GitHub Actions)', 'Accept': 'application/json'}

def get(url, tries=4):
    # 遇到「呼叫太頻繁」(429) 就等一下再試
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and k < tries - 1:
                time.sleep(20 * (k + 1)); continue
            raise
    return None

def probe(url):
    # 看看影像網址是圖片串流還是網頁播放器
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA['User-Agent']})
        with urllib.request.urlopen(req, timeout=8) as r:
            ct = (r.headers.get('Content-Type') or '').lower()
            return 'img' if ct.startswith('image') or 'multipart' in ct else ('page' if 'html' in ct else ct[:30] or 'unknown')
    except Exception as e:
        return 'err:' + type(e).__name__

def main():
    out = {'t': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec='minutes'), 'src': {}, 'cams': []}
    report = []
    groups = [('fw', 'Freeway'), ('hw', 'Highway')] + [(k, 'City/' + k) for k in CITIES]
    for code, path in groups:
        try:
            j = get(BASE + path + '?$format=JSON')
            L = j.get('CCTVs', []) if j else []
            n = 0
            for x in L:
                u = x.get('VideoStreamURL') or x.get('VideoImageURL') or ''
                lat, lon = x.get('PositionLat'), x.get('PositionLon')
                if not u.startswith('http') or not lat or not lon: continue
                name = x.get('RoadName') or x.get('RoadSection', {}).get('Start', '') or ''
                if code in ('fw', 'hw'):
                    sec = x.get('RoadSection') or {}
                    extra = (sec.get('Start', '') + '→' + sec.get('End', '')) if sec.get('Start') else ''
                    mile = x.get('LocationMile') or ''
                else:
                    extra, mile = '', ''
                out['cams'].append([code, x.get('CCTVID', ''), name, x.get('RoadDirection', '') or '', round(lon, 6), round(lat, 6), u, x.get('RoadClass', -1), mile, extra])
                n += 1
            out['src'][code] = n
            report.append(f'{code}: {len(L)} 筆，可用 {n}；欄位：{sorted(L[0].keys()) if L else "-"}')
            if L: report.append('   範例：' + json.dumps(L[0], ensure_ascii=False)[:600])
        except Exception as e:
            out['src'][code] = 'error'
            report.append(f'{code}: 失敗 {e}')
        time.sleep(2.5)
    # 每個影像主機抽一支測格式
    hosts = {}
    for c in out['cams']:
        m = re.match(r'https?://([^/]+)', c[6]); h = m.group(1) if m else '-'
        if h not in hosts: hosts[h] = c[6]
    out['hosts'] = {}
    for h, u in hosts.items():
        out['hosts'][h] = probe(u)
    report.append('影像主機格式：' + json.dumps(out['hosts'], ensure_ascii=False))
    os.makedirs('data', exist_ok=True)
    json.dump(out, open('data/cams.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    open('data/report.txt', 'w', encoding='utf-8').write(out['t'] + '\n' + '\n'.join(report) + '\n')
    print('\n'.join(report))

main()
