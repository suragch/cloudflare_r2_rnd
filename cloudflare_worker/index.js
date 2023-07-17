const { Auth, WorkersKVStoreSingle } = require("firebase-auth-cloudflare-workers");
import { AwsClient } from "aws4fetch";
import { nanoid } from 'nanoid';

let r2;

const isAuthenticated = async (req, env) => {
  const authorization = req.headers.get('Authorization');
  if (authorization === null) {
    console.log('No auth header');
    return null;
  }
  const jwt = authorization.replace(/Bearer\s+/i, "");
  const auth = Auth.getOrInitialize(
    env.PROJECT_ID,
    WorkersKVStoreSingle.getOrInitialize(env.PUBLIC_JWK_CACHE_KEY, env.FIREBASE_AUTH_KV)
  );
  try {
    const token = await auth.verifyIdToken(jwt, env);
    console.log(token);
    return token;
  } catch (error) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    // check Firebase authentication
    const token = await isAuthenticated(request, env);
    if (token) {
      console.log('User authenticated');
    } else {
      return new Response('User not authenticated', {
        status: 400,
      });
    }

    if (!r2) {
      r2 = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });
    }

    // get object name
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    console.log(key);

    var usePublicBucket = false;
    const queryParam = url.searchParams.get("type");
    if (queryParam === "public") {
      usePublicBucket = true;
    }
    console.log(`usePublicBucket: ${usePublicBucket}`);

    if (usePublicBucket) {
      return handlePublicBucketRequests(request, env);
    } else {
      return handlePresignedUrlRequests(request, env);
    }
  },
};

const handlePublicBucketRequests = async (request, env) => {
  const url = new URL(request.url);
  const key = url.pathname.slice(1);
  switch (request.method) {
    case 'PUT':
      const id = nanoid();
      const parts = key.split('/');
      const filename = parts.pop();
      const newKey = `${parts.join('/')}/${id}-${filename}`;
      await env.PUBLIC_BUCKET.put(newKey, request.body);
      const baseUrl = 'https://pub-7becc1335fd2498aae4414f0e6c8643b.r2.dev/'
      return new Response(`${baseUrl}${newKey}`);
    case 'GET':
      // return a list of object in the media folder
      const result = await env.PUBLIC_BUCKET.list({prefix: 'media/'});
      const keys = result.objects.map(object => object.key);
      console.log(keys);
      return new Response(JSON.stringify(keys), {
        headers: {'content-type': 'application/json;charset=UTF-8'},
      });
    case 'DELETE':
      await env.PUBLIC_BUCKET.delete(key);
      return new Response(`${key} was successfully deleted!`);
    default:
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          Allow: 'PUT, GET, DELETE',
        },
      });
  }
}

const handlePresignedUrlRequests = async (request, env) => {
    let signedUrl;
    switch (request.method) {
      case 'PUT':
        signedUrl = await signUrl("PUT", request.url, env);
        return new Response(signedUrl, { status: 200 });
      case 'GET':
        signedUrl = await signUrl("GET", request.url, env);
        return new Response(signedUrl, { status: 200 });
      case 'DELETE':
        signedUrl = await signUrl("DELETE", request.url, env);
        return new Response(signedUrl, { status: 200 });
      default:
        return new Response('Method Not Allowed', {
          status: 405,
          headers: {
            Allow: 'PUT, GET, DELETE',
          },
        });
    }
}

const signUrl = async (method, requestUrl, env) => {
  console.log(`method: ${method}`);
  console.log(`requestUrl: ${requestUrl}`);
  const requestPath = new URL(requestUrl).pathname;
  console.log(`requestPath: ${requestPath}`);
  if (requestPath === "/") {
    return new Response("Missing a filepath", { status: 400 });
  }
  const urlString = `https://cloudflare-r2-poc-bucket.${env.ACCOUNT_ID}.r2.cloudflarestorage.com`;
  console.log(`urlString: ${urlString}`);
  const url = new URL(urlString);
  url.pathname = requestPath;
  url.searchParams.set("X-Amz-Expires", "3600");
  const signed = await r2.sign(
    new Request(url, {
      method: method,
    }),
    {
      aws: { signQuery: true },
    }
  );
  return signed.url;
}