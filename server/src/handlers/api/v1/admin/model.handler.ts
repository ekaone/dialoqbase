// this the dedicated file for the model handler for the admin route
// why i do this? because i want to make the code more readable and easy to maintain
import { FastifyReply, FastifyRequest } from "fastify";
import {
  FetchModelFromInputedUrlRequest,
  SaveEmbeddingModelRequest,
  SaveModelFromInputedUrlRequest,
  ToogleModelRequest,
} from "./type";
import axios from "axios";
import { removeTrailingSlash } from "../../../../utils/url";
import { getSettings } from "../../../../utils/common";

const _getModelFromUrl = async (url: string, apiKey?: string) => {
  try {
    const response = await axios.get(`${url}/models`, {
      headers: {
        "HTTP-Referer":
          process.env.LOCAL_REFER_URL || "https://dialoqbase.n4ze3m.com/",
        "X-Title": process.env.LOCAL_TITLE || "Dialoqbase",
        Authorization: apiKey && `Bearer ${apiKey}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const _getOllamaModels = async (url: string) => {
  try {
    const response = await axios.get(`${url}/api/tags`);
    const { models } = response.data as {
      models: {
        name: string;
      }[];
    };
    return models.map((data) => {
      return {
        id: data.name,
        object: data.name,
      };
    });
  } catch (error) {
    return null;
  }
};

const _isReplicateModelExist = async (model_id: string, token: string) => {
  try {
    const url = "https://api.replicate.com/v1/models/";
    const isVersionModel = model_id.split(":").length > 1;
    if (!isVersionModel) {
      const res = await axios.get(`${url}${model_id}`, {
        headers: {
          Authorization: `Token ${token}`,
        },
      });
      const data = res.data;
      return {
        success: true,
        message: "Model found",
        name: data.name,
      };
    } else {
      const [owner, model_name] = model_id.split("/");
      const version = model_name.split(":")[1];
      const res = await axios.get(
        `${url}${owner}/${model_name.split(":")[0]}/versions/${version}`,
        {
          headers: {
            Authorization: `Token ${token}`,
          },
        }
      );

      const data = res.data;

      return {
        success: true,
        message: "Model found",
        name: data.name,
      };
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(error.response?.data);
      if (error.response?.status === 404) {
        return {
          success: false,
          message: "Model not found",
          name: undefined,
        };
      } else if (error.response?.status === 401) {
        return {
          success: false,
          message: "Unauthorized",
          name: undefined,
        };
      } else if (error.response?.status === 403) {
        return {
          success: false,
          message: "Forbidden",
          name: undefined,
        };
      } else if (error.response?.status === 500) {
        return {
          success: false,
          message: "Internal Server Error",
          name: undefined,
        };
      } else {
        return {
          success: false,
          message: "Internal Server Error",
          name: undefined,
        };
      }
    } else {
      return {
        success: false,
        message: "Internal Server Error",
        name: undefined,
      };
    }
  }
};

export const getAllModelsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const prisma = request.server.prisma;
  const user = request.user;

  if (!user.is_admin) {
    return reply.status(403).send({
      message: "Forbidden",
    });
  }

  const settings = await getSettings(prisma);

  const not_to_hide_providers = settings?.hideDefaultModels
    ? [ "Local", "local", "ollama", "transformer", "Transformer"]
    : undefined;
  const allModels = await prisma.dialoqbaseModels.findMany({
    where: {
      deleted: false,
      model_provider: {
        in: not_to_hide_providers,
      },
    },
  });
  try {
    return {
      data: allModels.filter((model) => model.model_type !== "embedding"),
      embedding: allModels.filter((model) => model.model_type === "embedding"),
    };
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};

export const fetchModelFromInputedUrlHandler = async (
  request: FastifyRequest<FetchModelFromInputedUrlRequest>,
  reply: FastifyReply
) => {
  try {
    const { url, api_key, api_type, ollama_url } = request.body;
    const user = request.user;
    if (!user.is_admin) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    if (api_type === "ollama") {
      const models = await _getOllamaModels(removeTrailingSlash(ollama_url!));

      if (!models) {
        return reply.status(404).send({
          message:
            "Unable to fetch models from Ollama. Make sure Ollama is running and the url is correct",
        });
      }

      return {
        data: models,
      };
    } else if (api_type === "openai") {
      const model = await _getModelFromUrl(removeTrailingSlash(url!), api_key);

      if (!model) {
        return reply.status(404).send({
          message:
            "Unable to fetch models. Make sure the url is correct and if the model is protected by api key, make sure the api key is correct",
        });
      }

      return {
        data: Array.isArray(model) ? model : model.data,
      };
    }
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};

export const saveModelFromInputedUrlHandler = async (
  request: FastifyRequest<SaveModelFromInputedUrlRequest>,
  reply: FastifyReply
) => {
  try {
    const user = request.user;
    const prisma = request.server.prisma;

    if (!user.is_admin) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    const { url, api_key, model_id, name, stream_available, api_type } =
      request.body;

    if (api_type === "replicate") {
      const isModelExist = await _isReplicateModelExist(model_id, api_key!);

      if (!isModelExist.success) {
        return reply.status(404).send({
          message: isModelExist.message,
        });
      }

      const modelExist = await prisma.dialoqbaseModels.findFirst({
        where: {
          model_id: model_id,
          hide: false,
          deleted: false,
        },
      });

      if (modelExist) {
        return reply.status(400).send({
          message: "Model already exist",
        });
      }

      let newModelId = model_id.trim() + `_dialoqbase_${new Date().getTime()}`;
      await prisma.dialoqbaseModels.create({
        data: {
          name: isModelExist.name,
          model_id: newModelId,
          stream_available: stream_available,
          local_model: true,
          model_provider: "replicate",
          config: {
            baseURL: "https://api.replicate.com/v1/models/",
            apiKey: api_key,
          },
        },
      });

      return {
        message: "success",
      };
    }
    let newModelId = model_id.trim() + `_dialoqbase_${new Date().getTime()}`;

    await prisma.dialoqbaseModels.create({
      data: {
        name: name,
        model_id: newModelId,
        stream_available: stream_available,
        local_model: true,
        model_provider: api_type === "openai" ? "local" : "ollama",
        config: {
          baseURL: removeTrailingSlash(url),
          apiKey: api_key,
        },
      },
    });

    return {
      message: "success",
    };
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};

export const hideModelHandler = async (
  request: FastifyRequest<ToogleModelRequest>,
  reply: FastifyReply
) => {
  try {
    const { id } = request.body;

    const user = request.user;

    const prisma = request.server.prisma;

    if (!user.is_admin) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    const model = await prisma.dialoqbaseModels.findFirst({
      where: {
        id: id,
        deleted: false,
      },
    });

    if (!model) {
      return reply.status(404).send({
        message: "Model not found",
      });
    }

    await prisma.dialoqbaseModels.update({
      where: {
        id: id,
      },
      data: {
        hide: !model.hide,
      },
    });

    return {
      message: "success",
    };
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};

export const deleteModelHandler = async (
  request: FastifyRequest<ToogleModelRequest>,
  reply: FastifyReply
) => {
  try {
    const { id } = request.body;

    const user = request.user;

    const prisma = request.server.prisma;

    if (!user.is_admin) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    const model = await prisma.dialoqbaseModels.findFirst({
      where: {
        id: id,
        deleted: false,
      },
    });

    if (!model) {
      return reply.status(404).send({
        message: "Model not found",
      });
    }

    if (!model.local_model) {
      return reply.status(400).send({
        message: "Only local model can be deleted",
      });
    }

    await prisma.dialoqbaseModels.delete({
      where: {
        id: id,
      },
    });

    return {
      message: "success",
    };
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};

export const saveEmbedddingModelFromInputedUrlHandler = async (
  request: FastifyRequest<SaveEmbeddingModelRequest>,
  reply: FastifyReply
) => {
  try {
    const user = request.user;
    const prisma = request.server.prisma;

    if (!user.is_admin) {
      return reply.status(403).send({
        message: "Forbidden",
      });
    }

    const { url, api_key, model_id, model_name, api_type } = request.body;

    const modelExist = await prisma.dialoqbaseModels.findFirst({
      where: {
        model_id: model_id,
        model_type: "embedding",
        hide: false,
        deleted: false,
      },
    });

    if (modelExist) {
      return reply.status(400).send({
        message: "Model already exist",
      });
    }

    const model_provider = {
      openai: "local",
      ollama: "ollama",
      transformer: "transformer",
    };

    let newModelId =
      `dialoqbase_eb_${model_id}`.trim() +
      `_dialoqbase_${new Date().getTime()}`;

    await prisma.dialoqbaseModels.create({
      data: {
        name: model_name,
        model_id: newModelId,
        local_model: true,
        model_type: "embedding",
        model_provider: model_provider[api_type],
        config: {
          baseURL: url && removeTrailingSlash(url),
          apiKey: api_key,
        },
      },
    });

    return {
      message: "success",
    };
  } catch (error) {
    console.error(error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};
