<?php
declare(strict_types=1);

// Install outside the web root. Operator actions are never exposed as web endpoints.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/Cabinet.php';

try {
    $path = getenv('VD_CABINET_CONFIG');
    $real = is_string($path) && $path !== '' ? realpath($path) : false;
    if (!$real || !is_file($real) || ((int)fileperms($real) & 0077) !== 0) { throw new RuntimeException('Private config required'); }
    $config = require $real;
    $public = is_array($config) ? realpath((string)($config['public_root'] ?? '')) : false;
    if (!$public || str_starts_with($real . '/', rtrim($public, '/') . '/')) { throw new RuntimeException('Config must be outside web root'); }
    $service = new VashDoctor\Cabinet($config);
    $raw = stream_get_contents(STDIN, 16385);
    if (!is_string($raw) || strlen($raw) > 16384) { throw new RuntimeException('Input too large'); }
    $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    if (!is_array($data)) { throw new RuntimeException('JSON object required'); }
    $result = match ($argv[1] ?? '') {
        'children' => $service->operatorChildren($data['email'] ?? ''),
        'provision-doctor' => $service->provisionDoctor($data['fullName'] ?? '', $data['phone'] ?? ''),
        'assign-doctor' => $service->assignDoctor($data['doctorId'] ?? '', $data['childId'] ?? '', $data['evidence'] ?? ''),
        'unassign-doctor' => $service->unassignDoctor($data['doctorId'] ?? '', $data['childId'] ?? ''),
        default => throw new RuntimeException('Unknown command'),
    };
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, "Операция не выполнена. Проверьте приватную конфигурацию, команду и входные данные.\n");
    exit(1);
}
