B-MAX NVIDIA Render Patch — GitHub paths

आपके मौजूदा Render service का Root Directory blank है और repository backend-only है। इसलिए ZIP के contents को GitHub repository root में इस तरह रखें:

1) src/server.ts  -> repository के मौजूदा src/server.ts को replace करें।
2) src/routes/nvidia-ai.routes.ts -> नया file add करें।
3) src/routes/settings.routes.ts -> repository के मौजूदा file को replace करें (OCR engine status को NVIDIA बताने के लिए)।

package.json, tsconfig.json, Build Command और Start Command न बदलें।
Build: npm install && npm run build
Start: npm start

तीनों files को main branch में commit करें। Render auto-deploy complete होने के बाद Environment में ये variables रखें:
NVIDIA_API_KEY = आपकी NVIDIA API key (सिर्फ Render में)
NVIDIA_OCR_URL = https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2
NVIDIA_CHAT_BASE_URL = https://integrate.api.nvidia.com/v1
NVIDIA_CHAT_MODEL = nvidia/nemotron-3-nano-omni-30b-a3b-reasoning

BMAX_PHP_ACCOUNT_API_URL और BMAX_PHP_ACCOUNT_API_TOKEN पहले से configured हैं तो उन्हें न बदलें। NVIDIA key GitHub/source/EXE में कभी न डालें।
