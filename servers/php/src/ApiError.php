<?php
declare(strict_types=1);
namespace StepDoc;

final class ApiError extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $status = 400, public readonly ?int $currentVersion = null)
    {
        parent::__construct('Storage operation failed: ' . $errorCode);
    }
}
