// lib/api/client.ts
import axios, { type AxiosError } from 'axios';
import { logger } from '@/lib/logger';

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

apiClient.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    // Previously silent — a failed request had zero trace anywhere unless
    // the calling component happened to render `.isError`. Log every one.
    logger.error('API request failed', {
      method: error.config?.method,
      url:    error.config?.url,
      status: error.response?.status,
      data:   error.response?.data,
      message: error.message,
    });

    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
