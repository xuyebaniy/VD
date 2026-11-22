<?php
declare(strict_types=1);
/**
 * Place on the CLINIC HOST as /local/api/vd-pwa/v1/telegram-feedback.php.
 * Not executable by GitHub Pages. Never commit bot tokens to GitHub.
 * General organizational questions only: do not submit medical or identity data.
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed = ['https://xuyebaniy.github.io', 'https://vash-doc.ru', 'https://www.vash-doc.ru'];
if ($origin !== '' && !in_array($origin, $allowed, true)) {
    http_response_code(403); echo '{"ok":false,"message":"Origin not allowed"}'; exit;
}
if ($origin !== '') {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {http_response_code(204);exit;}
function answer(int $status, array $data): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
$token = (string)(getenv('VD_TG_BOT_TOKEN') ?: '');
$chatId = (string)(getenv('VD_TG_PRIVATE_CHAT_ID') ?: '');
// The public @vashdoktr channel must never receive patient questions.
// Only a PRIVATE Telegram operator supergroup with a negative numeric ID.
$ready = (bool) preg_match('/^[0-9]{5,12}:[A-Za-z0-9_-]{25,}$/', $token)
    && (bool) preg_match('/^-100[0-9]{7,18}$/', $chatId)
    && extension_loaded('curl') && extension_loaded('mbstring');
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['health'] ?? '') === '1') {
    answer(200,['ok'=>true,'ready'=>$ready]);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') answer(405,['ok'=>false,'message'=>'Method not allowed']);
if (!$ready) answer(503,['ok'=>false,'message'=>'Operator channel is not configured']);
$length=(int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($length<1||$length>4096) answer(413,['ok'=>false,'message'=>'Invalid message size']);
$raw=file_get_contents('php://input');
if (!is_string($raw)||strlen($raw)>4096) answer(400,['ok'=>false,'message'=>'Invalid message']);
$data=json_decode($raw,true);
if (!is_array($data)||($data['consent'] ?? false)!==true||!empty($data['homepage'])) {
    answer(400,['ok'=>false,'message'=>'Consent is required']);
}
$message=trim((string)($data['text'] ?? ''));
if ($message===''||mb_strlen($message,'UTF-8')>1000) {
    answer(422,['ok'=>false,'message'=>'Message must be 1-1000 characters']);
}
// This endpoint rejects obvious identity-document formats, not a guarantee
// that it can recognize all categories of sensitive information.
if (preg_match('/(?:\b\d{4}\s?\d{6}\b|\b\d{3}-\d{3}-\d{3}\s?\d{2}\b)/u',$message)) {
    answer(422,['ok'=>false,'message'=>'Do not send identity documents']);
}
$ip=(string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
$path=sys_get_temp_dir().'/vd-operator-'.hash('sha256',$ip.'vd-operator-2026').'.json';
$f=@fopen($path,'c+');
if (!$f||!flock($f,LOCK_EX))answer(503,['ok'=>false,'message'=>'Rate limiter unavailable']);
$previous=json_decode(stream_get_contents($f) ?: '{}',true);
$now=time();
$start=is_array($previous)?(int)($previous['start']??0):0;
$count=is_array($previous)?(int)($previous['count']??0):0;
if ($now-$start>=900){$start=$now;$count=0;}
if ($count>=3){flock($f,LOCK_UN);fclose($f);answer(429,['ok'=>false,'message'=>'Too many requests']);}
rewind($f);ftruncate($f,0);fwrite($f,json_encode(['start'=>$start,'count'=>$count+1]));
fflush($f);flock($f,LOCK_UN);fclose($f);
$payload=[
    'chat_id'=>$chatId,
    'text'=>"Обращение из приложения «Ваш Доктор»\nОрганизационный вопрос\n\n".$message,
    'disable_web_page_preview'=>'true'
];
$curl=curl_init('https://api.telegram.org/bot'.$token.'/sendMessage');
curl_setopt_array($curl,[
    CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>http_build_query($payload),
    CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>7,CURLOPT_TIMEOUT=>12,
    CURLOPT_SSL_VERIFYPEER=>true,
    CURLOPT_HTTPHEADER=>['Content-Type: application/x-www-form-urlencoded']
]);
$rawResponse=curl_exec($curl);
$status=(int)curl_getinfo($curl,CURLINFO_HTTP_CODE);
curl_close($curl);
$response=is_string($rawResponse)?json_decode($rawResponse,true):null;
if ($status!==200||!is_array($response)||($response['ok']??false)!==true) {
    answer(502,['ok'=>false,'message'=>'Telegram did not confirm delivery']);
}
answer(200,['ok'=>true,'delivered'=>true]);
