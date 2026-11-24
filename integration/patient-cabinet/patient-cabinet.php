<?php
declare(strict_types=1);

use VashDoctor\ApiError;
use VashDoctor\Cabinet;

ini_set('display_errors', '0');
ini_set('expose_php', '0');
header_remove('X-Powered-By');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox");
header('X-Frame-Options: DENY');
header('Vary: Origin');

require_once __DIR__ . '/Cabinet.php';

function respond(array $body, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}
function health(bool $ready): array
{
    return ['ready' => $ready, 'service' => 'patient-cabinet', 'apiVersion' => 2,
        'auth' => ['parent' => 'email', 'doctor' => 'unavailable']];
}

try {
    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : 'health';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $documentRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    $configPath = getenv('VD_CABINET_CONFIG');
    $realConfig = is_string($configPath) && $configPath !== '' ? realpath($configPath) : false;
    if (!$documentRoot || !$realConfig || !is_file($realConfig) || !is_readable($realConfig) ||
        str_starts_with($realConfig . '/', rtrim($documentRoot, '/') . '/') || ((int)fileperms($realConfig) & 0077) !== 0) {
        if ($action === 'health' && $method === 'GET') { respond(health(false)); }
        throw new ApiError(503, 'NOT_CONFIGURED', 'Вход по почте пока не подключён.');
    }
    $config = require $realConfig;
    if (!is_array($config) || realpath((string)($config['public_root'] ?? '')) !== $documentRoot) { throw new ApiError(503, 'NOT_CONFIGURED', 'Вход по почте пока не подключён.'); }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && !in_array($origin, $config['allowed_origins'] ?? [], true)) { throw new ApiError(403, 'ORIGIN_DENIED', 'Этот адрес приложения не разрешён.'); }
    if ($origin !== '') { header('Access-Control-Allow-Origin: ' . $origin); }
    if ($method === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
        header('Access-Control-Max-Age: 300');
        http_response_code(204);
        exit;
    }
    // TLS is configured by the web server. Never trust client X-Forwarded-* headers here.
    if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') { throw new ApiError(400, 'HTTPS_REQUIRED', 'Используйте защищённое соединение HTTPS.'); }
    try { $service = new Cabinet($config); }
    catch (Throwable $error) { if ($action === 'health' && $method === 'GET') { respond(health(false)); } throw $error; }
    $methods = ['health' => 'GET', 'request-code' => 'POST', 'verify-code' => 'POST', 'me' => 'GET', 'children' => 'POST',
        'garden' => ['GET', 'PUT'], 'documents' => 'GET', 'logout' => 'POST', 'doctor-children' => 'GET',
        'doctor-garden' => 'GET', 'doctor-recommendations' => 'PUT', 'request-doctor-code' => 'POST', 'verify-doctor-code' => 'POST'];
    if (!array_key_exists($action, $methods)) { throw new ApiError(404, 'NOT_FOUND', 'Метод не найден.'); }
    if (!in_array($method, (array)$methods[$action], true)) { throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.'); }
    if ($action === 'health') { respond(health(true)); }
    if ($action === 'request-doctor-code' || $action === 'verify-doctor-code') { throw new ApiError(503, 'DOCTOR_AUTH_UNAVAILABLE', 'Вход врача по SMS подключим отдельно.'); }
    $body = [];
    if (in_array($method, ['POST', 'PUT'], true)) {
        if (!preg_match('~^application/json(?:;|$)~i', $_SERVER['CONTENT_TYPE'] ?? '')) { throw new ApiError(415, 'JSON_REQUIRED', 'Требуется JSON.'); }
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) { throw new ApiError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос.'); }
        $raw = file_get_contents('php://input', false, null, 0, 16385);
        if ($raw === false || strlen($raw) > 16384) { throw new ApiError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос.'); }
        try { $object = json_decode($raw, false, 16, JSON_THROW_ON_ERROR); }
        catch (JsonException $error) { throw new ApiError(400, 'INVALID_JSON', 'Некорректный запрос.'); }
        if (!$object instanceof stdClass) { throw new ApiError(400, 'INVALID_JSON', 'Требуется объект JSON.'); }
        $body = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    }
    if ($action === 'request-code') { respond($service->requestCode($body, $_SERVER['REMOTE_ADDR'] ?? 'unknown')); }
    if ($action === 'verify-code') {
        if (array_diff(array_keys($body), ['challengeId', 'code'])) { throw new ApiError(422, 'INVALID_FIELD', 'Запрос содержит неизвестное поле.'); }
        respond($service->verifyCode($body['challengeId'] ?? null, $body['code'] ?? null));
    }
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    $token = preg_match('/^Bearer ([A-Za-z0-9_-]{43})$/D', $authorization, $matches) ? $matches[1] : '';
    $account = $service->authenticate($token);
    $childId = $_GET['childId'] ?? null;
    if ($action === 'me') { respond($service->me($account)); }
    if ($action === 'children') { respond($service->createChild($account, $body), 201); }
    if ($action === 'garden') { respond($method === 'PUT' ? $service->saveGarden($account, $childId, $body) : $service->garden($account, $childId, $_GET['month'] ?? null)); }
    if ($action === 'documents') { respond($service->documents($account, $childId)); }
    if ($action === 'logout') { respond($service->logout($token, $account)); }
    if ($action === 'doctor-children') { respond($service->doctorChildren($account)); }
    if ($action === 'doctor-garden') { respond($service->doctorGarden($account, $childId, $_GET['month'] ?? null)); }
    if ($action === 'doctor-recommendations') { respond($service->doctorRecommendations($account, $childId, $body)); }
    throw new ApiError(404, 'NOT_FOUND', 'Метод не найден.');
} catch (ApiError $error) {
    if ($error->retryAfter > 0) { header('Retry-After: ' . $error->retryAfter); }
    respond(['error' => ['code' => $error->errorCode, 'message' => $error->getMessage()], 'retryAfter' => $error->retryAfter], $error->status);
} catch (Throwable $error) {
    // No exception text, request bodies, OTP, bearer tokens or SMTP details in output/logs.
    respond(['error' => ['code' => 'SERVICE_UNAVAILABLE', 'message' => 'Личный кабинет временно недоступен. Попробуйте позже.']], 503);
}
