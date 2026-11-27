<?php
declare(strict_types=1);
namespace StepDoc;

final class GuideValidator
{
    private readonly \Opis\JsonSchema\Validator $validator;
    private readonly object $schema;
    public function __construct()
    {
        $this->validator = new \Opis\JsonSchema\Validator();
        // Match the existing ajv-formats UUID vocabulary, including UUID URNs.
        // Keep the original value in guide JSON; this changes no guide fields.
        $this->validator->parser()->getFormatResolver()->registerCallable('string', 'uuid', static fn(string $value): bool => (bool) preg_match('~^(?:urn:uuid:)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$~iD', $value));
        $this->schema = json_decode(file_get_contents(__DIR__ . '/../../../docs/v2/guide.schema.json'), false, 512, JSON_THROW_ON_ERROR);
    }
    public function parse(mixed $guide): object
    {
        if (!$guide instanceof \stdClass || !$this->validator->validate($guide, $this->schema)->isValid()) throw new ApiError('invalid_guide');
        if ($guide->version > 9007199254740991) throw new ApiError('invalid_guide');
        $guide->version = (int) $guide->version;
        $ids = $indices = $variables = [];
        foreach ($guide->variables as $variable) {
            if (isset($variables[$variable->name])) throw new ApiError('invalid_guide');
            $variables[$variable->name] = $variable->kind;
        }
        foreach ($guide->steps as $step) {
            $index = json_encode($step->index, JSON_THROW_ON_ERROR);
            if (isset($ids['id:' . $step->id]) || isset($indices[$index])) throw new ApiError('invalid_guide');
            $ids['id:' . $step->id] = $indices[$index] = true;
            if (isset($step->value) && in_array($step->value->kind, ['secret', 'variable'], true) && ($variables[$step->value->variable] ?? null) !== $step->value->kind) throw new ApiError('invalid_guide');
        }
        return $guide;
    }
}
