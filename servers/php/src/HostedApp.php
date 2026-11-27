<?php
declare(strict_types=1);
namespace StepDoc;

final class HostedApp
{
    public function __construct(private readonly Config $config) {}
    public function serve(): void
    {
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $base = substr($this->config->apiPath, 0, -strlen('/api/v1'));
        if (is_string($path) && str_starts_with($path, $this->config->apiPath . '/')) return;
        if (is_string($path) && ($path === $base . '/browser' || str_starts_with($path, $base . '/browser/'))) {
            ClientApp::serve($this->config->appDir, $base . '/browser', ['stepdoc-base' => $base . '/browser']);
        }
        $metadata = ['stepdoc-api' => $this->config->apiPath . '/'];
        if ($path === $base . '/setup' && is_file(__DIR__ . '/../setup-key.sha256')) $metadata['stepdoc-install'] = $base . '/install.php';
        ClientApp::serve($this->config->appDir, $base, $metadata);
    }
}
