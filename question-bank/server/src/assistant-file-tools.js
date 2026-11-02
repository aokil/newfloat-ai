/** Canonical schemas for file handlers implemented by the native v2 extension. */
const DEFINITIONS = [
  {
    "type": "function",
    "function": {
      "name": "get_file_info",
      "description": "获取当前会话完整原件或已生成文件的信息。不给file_id时分页列出当前会话文件；只返回元数据，不读取正文。",
      "parameters": {
        "type": "object",
        "properties": {
          "file_id": {
            "type": "string",
            "maxLength": 80
          },
          "offset": {
            "type": "integer",
            "minimum": 0
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          }
        },
        "required": [],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "仅在需要理解、总结或处理内容时显式读取所选原件。TXT/基础DOCX完整读取后分块，complete=false必须继续next_offset，禁止把块当全文；PDF为本机OCR非保真提取。图片仅在已验证图片输入时返回独立阅读预览。纯格式转换直接调用转换工具，不需阅读。",
      "parameters": {
        "type": "object",
        "properties": {
          "file_id": {
            "type": "string",
            "maxLength": 80
          },
          "offset": {
            "type": "integer",
            "minimum": 0
          },
          "maximum_characters": {
            "type": "integer",
            "minimum": 1,
            "maximum": 6000
          },
          "source_encoding": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "file_id"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "convert_document",
      "description": "用明确上传的完整原件执行TXT→基础DOCX或基础DOCX→TXT，保留文字、逻辑换行、空行、Tab和前后空白。不支持.doc、复杂DOCX或PDF→Word，不使用模型摘录代替原件。",
      "parameters": {
        "type": "object",
        "properties": {
          "source_file_id": {
            "type": "string",
            "maxLength": 80
          },
          "target_format": {
            "type": "string",
            "enum": [
              "txt",
              "docx"
            ]
          },
          "output_name": {
            "type": "string",
            "maxLength": 200
          },
          "source_encoding": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "source_file_id",
          "target_format",
          "output_name"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "create_document",
      "description": "将用户明确提供的全文或AI实际处理后的完整文本生成合法TXT/DOCX/PDF文件。必须传完整text且注明来源；不能把read_file部分块当成原样转换或声称已处理完整原文件。",
      "parameters": {
        "type": "object",
        "properties": {
          "format": {
            "type": "string",
            "enum": [
              "txt",
              "docx",
              "pdf"
            ]
          },
          "text": {
            "type": "string",
            "maxLength": 65536
          },
          "content_origin": {
            "type": "string",
            "enum": [
              "user_text",
              "ai_processed"
            ]
          },
          "output_name": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "format",
          "text",
          "content_origin",
          "output_name"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "text_file_to_pdf",
      "description": "将明确上传的完整TXT原件生成A4单栏分页PDF，保留全部文字、硬换行和空行；不会把DOCX/PDF误当TXT，不使用正文摘录。",
      "parameters": {
        "type": "object",
        "properties": {
          "source_file_id": {
            "type": "string",
            "maxLength": 80
          },
          "output_name": {
            "type": "string",
            "maxLength": 200
          },
          "source_encoding": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "source_file_id",
          "output_name"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "images_to_pdf",
      "description": "使用当前会话已明确上传的JPEG/PNG/静态WebP完整原图，按实际上传顺序逐图生成一页A4 PDF，等比完整放入且不裁剪。纯转换无需图片视觉输入能力。",
      "parameters": {
        "type": "object",
        "properties": {
          "source_file_ids": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 80
            },
            "minItems": 1,
            "maxItems": 500,
            "uniqueItems": true
          },
          "output_name": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "source_file_ids",
          "output_name"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "convert_image",
      "description": "完整原尺寸JPEG/PNG/静态WebP互转，按EXIF方向校正。JPEG质量95，透明部分白底；PNG无损，WebP无损仅系统实际支持时可用。不静默缩图、不把动画首帧/HDR当普通图。无需视觉模型读取。",
      "parameters": {
        "type": "object",
        "properties": {
          "source_file_id": {
            "type": "string",
            "maxLength": 80
          },
          "target_format": {
            "type": "string",
            "enum": [
              "jpeg",
              "png",
              "webp_lossy",
              "webp_lossless"
            ]
          },
          "output_name": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "source_file_id",
          "target_format",
          "output_name"
        ],
        "additionalProperties": false
      }
    }
  }
];

export function assistantFileTools() {
  return DEFINITIONS.map(value => structuredClone(value));
}
