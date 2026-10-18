{
  "targets": [
    {
      "target_name": "som_programas",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/som_programas.cc"],
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
          "libraries": ["ole32.lib", "oleaut32.lib", "mmdevapi.lib", "version.lib", "uuid.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/utf-8"] }
          }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
